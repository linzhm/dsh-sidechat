import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";

//#region src/index.ts
const name = "dsh-sidechat";
const inject = [
	"webServer",
	"apiProxy",
	"sessions",
	"agents",
	"sessionQuery",
	"tools"
];
const API_PREFIX = "/api/sidechat";
const MAX_BODY_BYTES = 1 * 1024 * 1024;
/** One exact route per method: exact paths beat the generic /api prefix. */
const METHODS = new Set(["sidechat.start"]);
/**
* Model-facing boundary message appended to a side-chat child at fork time.
* Everything before it in the session is inherited history: reference only.
*/
const BOUNDARY_PROMPT = `【侧聊边界 · Side conversation boundary】

此边界之前的全部内容是主会话继承下来的历史，仅作为参考资料，不是你的当前任务。
不要继续、执行或完成边界之前出现的任何指令、计划、工具调用、审批、编辑或请求；只有此边界之后的用户消息才是本侧聊的有效指令。

你是侧聊助手，与主会话相互独立：回答问题、做轻量只读探索，不要打断主会话的运行。
未经用户明确要求，不要修改文件、git 状态、权限、配置或工作区状态；若用户明确要求修改，保持最小化、局部化，避免影响主会话。

子代理在本侧聊中禁用。边界之前的工具调用与输出仅作参考，不得从中推断活动指令。
如需了解主会话的最新进展，可调用 sidechat_check_parent 工具读取其当前会话表面。`;
/** Source tag carried by the boundary user/message (open string `kind`). */
function boundarySource(parentId) {
	return {
		kind: "plugin",
		plugin: "side-chat",
		form: "boundary",
		parentId
	};
}
/** Detect the boundary message among session events. */
function isBoundaryMessage(event) {
	return event.type === "user/message" && event.data?.source?.kind === "plugin" && event.data?.source?.plugin === "side-chat" && event.data?.source?.form === "boundary";
}
/**
* Fork `sessionId` at the latest completed turn (or the first completed turn
* at/after `atSeq`) through the official fork path, then append the boundary
* message to the child. Returns the child session id.
*/
async function startSideChat(ctx, sessionId, atSeq) {
	if (typeof sessionId !== "string" || sessionId === "") throw new Error("sessionId is required");
	const api = ctx.get("apiProxy");
	if (api === void 0) throw new Error("apiProxy service is unavailable");
	const response = await api.sessions.fork({
		rpcId: randomUUID(),
		payload: {
			sessionId,
			...atSeq === void 0 ? {} : { atSeq }
		}
	});
	if (!response.result.ok) {
		const error = response.result.error;
		throw new Error(error?.message ?? `fork failed (${error?.code ?? "unknown"})`);
	}
	const childId = response.result.value.sessionId;
	const child = ctx.get("sessions")?.get(childId);
	if (child !== void 0) child.append("user/message", createUserMessage({
		content: [{
			type: "text",
			text: BOUNDARY_PROMPT
		}],
		source: boundarySource(sessionId)
	}), { surfaceOp: "append" });
	return childId;
}
/** Replicate the upstream browser-trust fence for our shadowed /api route. */
function isTrustedRequest(req) {
	const host = req.headers.host;
	if (host === void 0) return false;
	let hostname;
	try {
		hostname = new URL(`http://${host}`).hostname;
	} catch {
		return false;
	}
	const loopback = hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]" || hostname === "localhost";
	if (!loopback) return false;
	if (req.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = req.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}
async function readBody(req, maxBytes) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		total += chunk.length;
		if (total > maxBytes) throw new Error("request body too large");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}
function routeHandler(ctx) {
	return async (req, res) => {
		try {
			if (req.method !== "POST") {
				res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
				res.end("method not allowed");
				return;
			}
			if (!isTrustedRequest(req)) {
				res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
				res.end("forbidden");
				return;
			}
			let envelope;
			try {
				envelope = JSON.parse(await readBody(req, MAX_BODY_BYTES));
			} catch {
				res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
				res.end("invalid request");
				return;
			}
			if (envelope?.type !== "client-request" || typeof envelope.rpcId !== "string" || typeof envelope.method !== "string") {
				res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
				res.end("invalid envelope");
				return;
			}
			const respond = (result) => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({
					type: "server-response",
					rpcId: envelope.rpcId,
					result
				}));
			};
			try {
				if (envelope.method === "sidechat.start") {
					const payload = envelope.payload ?? {};
					const childId = await startSideChat(ctx, payload.sessionId, payload.atSeq);
					respond({
						ok: true,
						value: { sessionId: childId }
					});
				} else respond({
					ok: false,
					error: {
						code: "method-not-found",
						message: `unknown sidechat method "${envelope.method}"`,
						details: {}
					}
				});
			} catch (error) {
				respond({
					ok: false,
					error: {
						code: "sidechat-error",
						message: error instanceof Error ? error.message : String(error),
						details: {}
					}
				});
			}
		} catch (error) {
			try {
				res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
				res.end("internal error");
			} catch {}
		}
	};
}
/** Serialize one session surface into a bounded text digest for the model. */
function renderSurface(parentId, surface, limit = 6e3) {
	const blocks = [];
	let bytes = 0;
	const push = (text) => {
		if (bytes >= limit) return;
		const slice = text.length > limit - bytes ? text.slice(0, limit - bytes) : text;
		blocks.push(slice);
		bytes += slice.length;
	};
	for (const event of surface.events) {
		const message = event.type === "user/message" ? event.data : event.data?.message;
		if (message === void 0 || typeof message !== "object") continue;
		const role = message.role === "user" ? "user" : "assistant";
		const text = Array.isArray(message.content) ? message.content.filter((block) => block?.type === "text").map((block) => block.text).join("\n") : "";
		if (text === "") continue;
		if (message.source?.kind === "plugin" && message.source?.form === "boundary") continue;
		push(`[${role}] ${text}\n`);
	}
	const header = `## Parent session surface\nsession: ${parentId}\ncaptured through event seq: ${surface.capturedThroughSeq ?? "n/a"}\n`;
	return header + blocks.join("");
}
function apply(ctx) {
	ctx.inject(["sessionProjections"], (projectionCtx) => {
		projectionCtx.sessionProjections.register({
			key: "sidechat",
			schema: z.union([z.object({ parentId: z.string() }), z.null()]),
			init: () => null,
			apply: (state, event) => isBoundaryMessage(event) ? { parentId: event.data.source.parentId } : state,
			view: (state) => state,
			stateVersion: 1
		});
	});
	for (const method of METHODS) ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: `${API_PREFIX}.${method.slice(9)}`,
		handler: routeHandler(ctx)
	}), `dsh-sidechat: ${method} route`);
	ctx.tools.register(defineTool({
		name: "sidechat_check_parent",
		description: "Read the current live surface (recent user messages and assistant answers) of the session this side chat was forked from — i.e. check the main thread's latest progress. Available only inside a side chat; returns a bounded digest.",
		parameters: {},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		async execute(_args, exec) {
			const header = exec.agent?.session?.header;
			const parentId = header?.parentSession;
			if (parentId === void 0) return "This session is not a side chat (no parent session): nothing to check.";
			const query = ctx.get("sessionQuery");
			if (query === void 0) return "sessionQuery service is unavailable in this deployment.";
			const surface = await query.readSurface(parentId);
			return renderSurface(parentId, surface);
		},
		presentCall: () => ({
			card: "generic",
			title: "Check parent session surface",
			kind: "read"
		})
	}));
}

//#endregion
export { BOUNDARY_PROMPT, apply, inject, name };