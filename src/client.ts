// dsh-sidechat — browser half.
//
// Renders two pieces of UI inside the conversation header:
//  - a "start side chat" action: forks the current session at its latest
//    completed turn (server side), then opens the child;
//  - a status chip shown while the current session IS a side chat: "from
//    <parent> · <parent status>" with jump-back and close (archive) actions.
//
// The parent's status is live: `running` arrives on host/session-status
// frames, `pendingInteraction` (approval/question) on mux frames, both for
// every session — the summaries in `ctx.sessions.list` update without the
// parent being open.
import { useState } from "react";
import { jsx } from "react/jsx-runtime";
import {
	IconArchiveOutline20,
	IconBranchOutline16,
	IconLoadingOutline16,
	IconRightUpOutline16
} from "@deepseek-ai/dsh-client-ui-primitives";

const inject = ["slots", "locale", "sessions", "workspaces"];

const zh = {
	"start": "侧聊",
	"startTooltip": "从当前状态开启一个侧聊（复制历史，历史仅作参考，不打断本会话）",
	"starting": "正在开启…",
	"startError": "无法开启侧聊",
	"fromMain": "来自主会话",
	"fromParent": "来自父会话",
	"statusRunning": "主会话运行中",
	"statusNeedsApproval": "主会话等待审批",
	"statusNeedsInput": "主会话等待输入",
	"statusFinished": "主会话已完成",
	"statusIdle": "主会话空闲",
	"jumpBack": "回到主会话",
	"jumpBackParent": "回到父会话",
	"close": "关闭侧聊",
	"closeHint": "归档本侧聊并回到主会话"
};
const en = {
	"start": "Side chat",
	"startTooltip": "Start a side chat from the current state (history is copied as reference only; the main session keeps running)",
	"starting": "Starting…",
	"startError": "Could not start side chat",
	"fromMain": "from main session",
	"fromParent": "from parent session",
	"statusRunning": "main running",
	"statusNeedsApproval": "main needs approval",
	"statusNeedsInput": "main needs input",
	"statusFinished": "main finished",
	"statusIdle": "main idle",
	"jumpBack": "Back to main",
	"jumpBackParent": "Back to parent",
	"close": "Close side chat",
	"closeHint": "Archive this side chat and return to the parent"
};

/** Minimal client→node envelope RPC for /api/sidechat.* (same wire as /api). */
async function sidechatRpc(method, payload) {
	const res = await fetch(`/api/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			type: "client-request",
			rpcId: crypto.randomUUID(),
			method,
			payload
		})
	});
	if (!res.ok) throw new Error(`sidechat transport failure: HTTP ${res.status}`);
	const full = await res.json();
	if (full?.result?.ok !== true) {
		throw new Error(full?.result?.error?.message ?? "sidechat request failed");
	}
	return full.result.value;
}

/**
* Header action: start a side chat from the current session and open the child.
* Props: `sessionId`, injected `startSideChat` (async, resolves the child id),
* `t`, plus standard renderer props.
*/
function StartSideChatAction({ sessionId, startSideChat, t }) {
	const [phase, setPhase] = useState("idle"); // idle | starting | error
	const onClick = () => {
		if (phase === "starting") return;
		setPhase("starting");
		startSideChat(sessionId).then(
			() => setPhase("idle"),
			(error) => {
				// eslint-disable-next-line no-console
				console.error("[dsh-sidechat] start failed:", error);
				setPhase("error");
				setTimeout(() => setPhase("idle"), 4000);
			}
		);
	};
	const title = phase === "error" ? `${t("startError")}: ${phase === "error" ? t("startTooltip") : ""}` : t("startTooltip");
	return jsx("span", {
		style: { display: "inline-flex", alignItems: "center", gap: 4 },
		children: [
			jsx("button", {
				type: "button",
				title,
				"aria-label": t("start"),
				onClick,
				disabled: phase === "starting",
				style: {
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					width: 24,
					height: 24,
					border: "none",
					borderRadius: 6,
					background: "transparent",
					color: "var(--dsw-alias-label-secondary)",
					cursor: "pointer",
					padding: 0
				},
				onMouseEnter: (event) => {
					event.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover)";
				},
				onMouseLeave: (event) => {
					event.currentTarget.style.background = "transparent";
				},
				children: phase === "starting"
					? jsx(IconLoadingOutline16, {})
					: jsx(IconBranchOutline16, {})
			}),
			phase === "error" && jsx("span", {
				style: { color: "var(--dsw-alias-danger-foreground, #c0392b)", fontSize: 12 },
				children: t("startError")
			})
		]
	});
}

/**
* Header utility chip shown only while the current session is a side chat:
* parent lineage + live parent status + jump-back / close actions.
* Props: `sessionId`, `useSessions`, injected `open`/`archive`, `t`.
*/
function SideChatStatus({ sessionId, useSessions, open, archive, t }) {
	const summary = useSessions((state) => state.byId[sessionId]);
	const marker = summary?.projectionValues?.sidechat;
	const parentId = marker?.parentId;
	const parent = useSessions((state) => parentId === void 0 ? void 0 : state.byId[parentId]);
	if (marker === void 0 || marker === null || parentId === void 0) return null;

	let statusKey = "statusIdle";
	if (parent !== void 0) {
		if (parent.pendingInteraction === "approval") statusKey = "statusNeedsApproval";
		else if (parent.pendingInteraction === "question" || parent.pendingInteraction === "plan-review") statusKey = "statusNeedsInput";
		else if (parent.running) statusKey = "statusRunning";
		else if (parent.completed) statusKey = "statusFinished";
	}
	const fromLabel = parent?.projectionValues?.sidechat ? t("fromParent") : t("fromMain");
	const backLabel = parent?.projectionValues?.sidechat ? t("jumpBackParent") : t("jumpBack");
	const style = {
		display: "inline-flex",
		alignItems: "center",
		gap: 4,
		padding: "2px 8px",
		borderRadius: 999,
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-label-secondary)",
		background: "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))"
	};
	const iconButton = {
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		width: 18,
		height: 18,
		border: "none",
		borderRadius: 4,
		background: "transparent",
		color: "var(--dsw-alias-label-secondary)",
		cursor: "pointer",
		padding: 0
	};
	return jsx("span", {
		style,
		"data-sidechat-status": true,
		children: [
			jsx("span", { children: `${fromLabel} · ${t(statusKey)}` }),
			jsx("button", {
				type: "button",
				title: backLabel,
				"aria-label": backLabel,
				style: iconButton,
				onClick: () => open(parentId),
				children: jsx(IconRightUpOutline16, {})
			}),
			jsx("button", {
				type: "button",
				title: t("closeHint"),
				"aria-label": t("close"),
				style: iconButton,
				onClick: () => {
					archive(sessionId);
					open(parentId);
				},
				children: jsx(IconArchiveOutline20, { size: 14 })
			})
		]
	});
}

function apply(ctx) {
	ctx.effect(() => ctx.locale.register(NS, { zh, en }), "sidechat: dictionaries");
	const sessions = ctx.get("sessions");
	const workspaces = ctx.get("workspaces");

	const startSideChat = async (sessionId) => {
		const value = await sidechatRpc("sidechat.start", { sessionId });
		sessions.open(value.sessionId);
		return value.sessionId;
	};

	// Entry: header actions row (mirrors the subagent-catalog seat).
	ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
		name: "conversation.session.header.actions",
		id: "side-chat-start",
		order: 20,
		locale: NS,
		inject: () => ({ startSideChat })
	}, StartSideChatAction));

	// Status: header utilities row, only rendered for side-chat children.
	ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
		name: "conversation.session.header.utilities",
		id: "side-chat-status",
		order: 10,
		locale: NS,
		inject: () => ({
			open: (sessionId) => sessions.open(sessionId),
			archive: (sessionId) => workspaces.archiveSession(sessionId)
		})
	}, SideChatStatus));
}

export { apply, inject };
