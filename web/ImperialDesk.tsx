import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
} from "react";
import type { Channel, ManagedPrompt, PlatformState } from "../shared/protocol";
import { animate } from "animejs";
import { contentDirty, matchesPrompt, noteDirty, promptKey } from "./drafts";
import type { Draft } from "./drafts";
import { formatTime } from "./Editor";
import type {
  DeskPhase,
  ImperialScene,
  SceneLayout,
  SceneSelection,
  ScreenPoint,
} from "./scene/ImperialScene";

interface Props {
  platform: PlatformState;
  drafts: Record<string, Draft>;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  onConfigure: (channel?: Channel) => void;
  onSync: () => void;
  syncing: boolean;
  onLogout: () => void;
  loggingOut: boolean;
  message: string;
  onDismissMessage: () => void;
  children: ReactNode;
}

const initialLayout: SceneLayout = {
  channels: {},
  prompts: {},
  editor: { x: 0, y: 0, width: 0, height: 0 },
};
const position = (point: ScreenPoint | undefined): CSSProperties | undefined =>
  point ? { left: point.x, top: point.y } : undefined;

function selectAdjacent(event: ReactKeyboardEvent<HTMLButtonElement>) {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key))
    return;
  const buttons = Array.from(
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
      "button",
    ) ?? [],
  );
  const step = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
  const next = buttons[buttons.indexOf(event.currentTarget) + step];
  if (next) {
    event.preventDefault();
    next.focus();
  }
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="desk-dialog"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="dialog-header">
        <h2>{title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label={`关闭${title}`}
          onClick={onClose}
        >
          ×
        </button>
      </header>
      {children}
    </dialog>
  );
}

export function ImperialDesk({
  platform,
  drafts,
  selectedKey,
  onSelect,
  onConfigure,
  onSync,
  syncing,
  onLogout,
  loggingOut,
  message,
  onDismissMessage,
  children,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<ImperialScene | null>(null);
  const actions = useRef({
    openChannel: (_id: string) => {},
    openPrompt: (_key: string) => {},
  });
  const platformRef = useRef(platform);
  platformRef.current = platform;
  const latest = useRef<SceneSelection>({ channelId: null, promptId: null });
  const [channelId, setChannelId] = useState<string | null>(null);
  const [channelPage, setChannelPage] = useState(0);
  const [promptPage, setPromptPage] = useState(0);
  const [narrow, setNarrow] = useState(window.innerWidth < 700);
  const [fallback, setFallback] = useState(false);
  const [ready, setReady] = useState(false);
  const [phase, setPhase] = useState<DeskPhase>("overview");
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const [layout, setLayout] = useState(initialLayout);
  const [panel, setPanel] = useState<"search" | "channels" | "account" | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const [searchPage, setSearchPage] = useState(0);
  const lastPromptKey = useRef<string | null>(null);
  const editorOverlay = useRef<HTMLDivElement>(null);
  const channelSize = narrow ? 3 : 5;
  const promptSize = narrow ? 2 : 4;
  const channelPages = Math.max(
    1,
    Math.ceil(platform.channels.length / channelSize),
  );
  const effectiveChannelPage = Math.min(channelPage, channelPages - 1);
  const channels = platform.channels.slice(
    effectiveChannelPage * channelSize,
    (effectiveChannelPage + 1) * channelSize,
  );
  const currentChannel = platform.channels.find(
    (channel) => channel.id === channelId,
  );
  const prompts = useMemo(
    () => platform.prompts.filter((prompt) => prompt.channelId === channelId),
    [platform.prompts, channelId],
  );
  const promptPages = Math.max(1, Math.ceil(prompts.length / promptSize));
  const effectivePromptPage = Math.min(promptPage, promptPages - 1);
  const visiblePrompts = prompts.slice(
    effectivePromptPage * promptSize,
    (effectivePromptPage + 1) * promptSize,
  );
  const channelSignature = channels.map((channel) => channel.id).join("|");
  const promptSignature = visiblePrompts.map(promptKey).join("|");
  const names = useMemo(
    () =>
      new Map(platform.channels.map((channel) => [channel.id, channel.name])),
    [platform.channels],
  );
  const results = useMemo(
    () =>
      platform.prompts.filter((prompt) =>
        matchesPrompt(prompt, names.get(prompt.channelId) ?? "", query),
      ),
    [platform.prompts, names, query],
  );
  const searchPages = Math.max(1, Math.ceil(results.length / 20));
  const effectiveSearchPage = Math.min(searchPage, searchPages - 1);
  const selection: SceneSelection = { channelId, promptId: selectedKey };
  latest.current = selection;

  function openChannel(id: string) {
    setChannelId(id);
    setPromptPage(0);
    setSettledKey(null);
    onSelect(null);
  }
  function openPrompt(key: string) {
    const prompt = platform.prompts.find((item) => promptKey(item) === key);
    if (!prompt) return;
    if (key === selectedKey) {
      setPanel(null);
      return;
    }
    lastPromptKey.current = key;
    setChannelId(prompt.channelId);
    setChannelPage(
      Math.floor(
        platform.channels.findIndex(
          (channel) => channel.id === prompt.channelId,
        ) / channelSize,
      ),
    );
    const peers = platform.prompts.filter(
      (item) => item.channelId === prompt.channelId,
    );
    setPromptPage(
      Math.floor(
        peers.findIndex((item) => promptKey(item) === key) / promptSize,
      ),
    );
    setSettledKey(null);
    onSelect(key);
    setPanel(null);
  }
  actions.current = { openChannel, openPrompt };

  function back() {
    if (selectedKey) {
      setSettledKey(null);
      onSelect(null);
    } else {
      setChannelId(null);
      setPromptPage(0);
    }
  }
  const backRef = useRef(back);
  backRef.current = back;

  useEffect(() => {
    if (!selectedKey) return;
    const prompt = platform.prompts.find(
      (item) => promptKey(item) === selectedKey,
    );
    if (!prompt || prompt.channelId === channelId) return;
    setChannelId(prompt.channelId);
    setChannelPage(
      Math.floor(
        platform.channels.findIndex(
          (channel) => channel.id === prompt.channelId,
        ) / channelSize,
      ),
    );
    const peers = platform.prompts.filter(
      (item) => item.channelId === prompt.channelId,
    );
    setPromptPage(
      Math.floor(
        peers.findIndex((item) => promptKey(item) === selectedKey) / promptSize,
      ),
    );
  }, [selectedKey, platform, channelId, channelSize, promptSize]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 699px)");
    const resize = () => {
      setNarrow(media.matches);
      const selectedChannel = latest.current.channelId;
      const index = platformRef.current.channels.findIndex(
        (channel) => channel.id === selectedChannel,
      );
      if (index >= 0)
        setChannelPage(Math.floor(index / (media.matches ? 3 : 5)));
      const peers = platformRef.current.prompts.filter(
        (prompt) => prompt.channelId === selectedChannel,
      );
      const promptIndex = peers.findIndex(
        (prompt) => promptKey(prompt) === latest.current.promptId,
      );
      if (promptIndex >= 0)
        setPromptPage(Math.floor(promptIndex / (media.matches ? 2 : 4)));
    };
    media.addEventListener("change", resize);
    return () => media.removeEventListener("change", resize);
  }, []);

  useEffect(() => {
    let active = true;
    const element = host.current!;
    void import("./scene/ImperialScene")
      .then((module) =>
        module.ImperialScene.create(element, {
          onPick: (kind, id) =>
            kind === "channel"
              ? actions.current.openChannel(id)
              : actions.current.openPrompt(id),
          onPhase: (nextPhase, target) => {
            if (
              !active ||
              target.channelId !== latest.current.channelId ||
              target.promptId !== latest.current.promptId
            )
              return;
            setPhase(nextPhase);
            setSettledKey(nextPhase === "editing" ? target.promptId : null);
          },
          onLayout: (nextLayout) => {
            if (active) setLayout(nextLayout);
          },
          onFailure: () => {
            if (active) setFallback(true);
          },
        }),
      )
      .then((instance) => {
        if (!active) {
          instance.dispose();
          return;
        }
        scene.current = instance;
        setReady(true);
      })
      .catch(() => {
        if (active) setFallback(true);
      });
    return () => {
      active = false;
      scene.current?.dispose();
      scene.current = null;
    };
  }, []);

  useEffect(() => {
    if (!ready || fallback) return;
    scene.current?.setItems(
      channels.map((channel) => ({
        id: channel.id,
        index: platform.channels.findIndex((item) => item.id === channel.id),
      })),
      visiblePrompts.map(promptKey),
    );
    scene.current?.transition(latest.current);
    // Only identities and page boundaries trigger scene changes. Polling metadata keeps the camera still.
  }, [
    ready,
    fallback,
    channelSignature,
    promptSignature,
    channelId,
    selectedKey,
  ]);

  useEffect(() => {
    if (!fallback) return;
    scene.current?.dispose();
    scene.current = null;
    setPhase(selectedKey ? "editing" : channelId ? "scrolls" : "overview");
    setSettledKey(selectedKey);
  }, [fallback, selectedKey, channelId]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || document.querySelector("dialog[open]")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        backRef.current();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPanel("search");
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);

  useEffect(() => {
    if (!settledKey || !editorOverlay.current) return;
    const animation = animate(editorOverlay.current, {
      opacity: [0, 1],
      duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? 1
        : 160,
    });
    editorOverlay.current.focus({ preventScroll: true });
    return () => {
      animation.cancel();
    };
  }, [settledKey]);

  useEffect(() => {
    if (phase !== "scrolls" || selectedKey || panel) return;
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".scroll-nameplate"),
    );
    const target =
      buttons.find(
        (button) => button.dataset.promptKey === lastPromptKey.current,
      ) ?? buttons[0];
    target?.focus({ preventScroll: true });
  }, [phase, selectedKey, panel]);

  function promptButton(prompt: ManagedPrompt, directory = false) {
    const key = promptKey(prompt);
    const draft = drafts[key];
    const dirty = draft && (contentDirty(draft) || noteDirty(draft));
    const source = platform.channels.find(
      (item) => item.id === prompt.channelId,
    );
    return (
      <button
        type="button"
        key={key}
        className={directory ? "directory-item" : "scroll-nameplate"}
        style={
          directory || fallback ? undefined : position(layout.prompts[key])
        }
        onClick={() => openPrompt(key)}
        aria-label={`展开${prompt.name}`}
        data-prompt-key={key}
        onKeyDown={selectAdjacent}
      >
        <span>
          {prompt.name}
          {dirty && <i className="draft-dot" aria-label="有未保存草稿" />}
        </span>
        <small>
          {directory
            ? names.get(prompt.channelId)
            : prompt.customized
              ? "自定义"
              : "默认内容"}
          {!prompt.active ? " · 已移除" : source?.error ? " · 离线副本" : ""}
        </small>
        {directory && <p>{prompt.description}</p>}
      </button>
    );
  }

  const editing = !!selectedKey && settledKey === selectedKey;
  return (
    <main
      className={`imperial-desk ${fallback ? "is-fallback" : ""} ${selectedKey ? "has-scroll" : ""}`}
      data-phase={phase}
    >
      <div ref={host} className="scene-host" />
      <header className="desk-header">
        <button
          className="desk-brand"
          type="button"
          onClick={() => {
            onSelect(null);
            setChannelId(null);
          }}
          aria-label="水墨御案，返回全景"
        >
          <span className="brand-seal" aria-hidden="true">
            御
          </span>
          <span>
            水墨御案<small>提示词管理</small>
          </span>
        </button>
        <nav className="desk-tools" aria-label="御案工具">
          <button type="button" onClick={() => setPanel("search")}>
            <span aria-hidden="true">⌕</span> 搜索
            <span className="shortcut">⌘ K</span>
          </button>
          <button type="button" onClick={onSync} disabled={syncing}>
            <span aria-hidden="true">↻</span> {syncing ? "同步中…" : "同步"}
          </button>
          <button type="button" onClick={() => setPanel("channels")}>
            渠道
          </button>
          <button
            type="button"
            onClick={() => onConfigure()}
            aria-label="添加渠道"
          >
            ＋<span className="add-label"> 添加渠道</span>
          </button>
          <button type="button" onClick={() => setPanel("account")}>
            账户
          </button>
        </nav>
      </header>
      {message && (
        <div className="desk-notice" role="status">
          <span>{message}</span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={onDismissMessage}
          >
            ×
          </button>
        </div>
      )}
      {fallback && (
        <p className="fallback-message" role="status">
          3D 场景暂不可用，已切换到可操作的目录与编辑视图。
        </p>
      )}
      {!ready && !fallback && (
        <p className="scene-loading" role="status">
          正在铺案…
        </p>
      )}
      {!channelId && !selectedKey && (
        <section className="desk-intro">
          <h1>选一只圣旨筒，翻阅你的提示词。</h1>
        </section>
      )}
      {channelId && (
        <div className="scene-breadcrumb">
          <button type="button" className="back-button" onClick={back}>
            {selectedKey ? "‹ 收卷" : "‹ 返回御案"}
          </button>
          <span>{currentChannel?.name}</span>
          {currentChannel && (
            <button
              type="button"
              onClick={() => onConfigure(currentChannel)}
              aria-label={`配置${currentChannel.name}`}
            >
              配置
            </button>
          )}
        </div>
      )}
      {!selectedKey && (
        <>
          <nav className="canister-labels" aria-label="圣旨筒渠道">
            {channels.map((channel) => (
              <button
                type="button"
                className={`canister-nameplate ${channelId === channel.id ? "active" : ""}`}
                key={channel.id}
                hidden={!fallback && !layout.channels[channel.id]}
                style={
                  fallback ? undefined : position(layout.channels[channel.id])
                }
                onClick={() => openChannel(channel.id)}
                onKeyDown={selectAdjacent}
                aria-pressed={channelId === channel.id}
              >
                <span>{channel.name}</span>
                <small>
                  {
                    platform.prompts.filter(
                      (prompt) => prompt.channelId === channel.id,
                    ).length
                  }{" "}
                  卷
                  <i
                    className={`connection-dot ${channel.error ? "offline" : ""}`}
                  />
                  {channel.syncing
                    ? "同步中"
                    : channel.error
                      ? "离线副本"
                      : "已连接"}
                </small>
              </button>
            ))}
          </nav>
          {channelPages > 1 && (
            <nav className="channel-pager" aria-label="渠道翻页">
              <button
                type="button"
                disabled={effectiveChannelPage === 0}
                onClick={() => {
                  setChannelPage(effectiveChannelPage - 1);
                  setChannelId(null);
                }}
              >
                ‹ 上一案
              </button>
              <span>
                {effectiveChannelPage + 1} / {channelPages}
              </span>
              <button
                type="button"
                disabled={effectiveChannelPage >= channelPages - 1}
                onClick={() => {
                  setChannelPage(effectiveChannelPage + 1);
                  setChannelId(null);
                }}
              >
                下一案 ›
              </button>
            </nav>
          )}
          {channelId && (
            <section className="scroll-catalog" aria-label="提示词卷轴">
              {currentChannel?.error && (
                <p className="offline-caption">
                  当前为离线副本 · 最近同步{" "}
                  {formatTime(currentChannel.lastSyncedAt)}
                </p>
              )}
              <div
                className={`scroll-labels ${phase === "scrolls" ? "" : "arriving"}`}
              >
                {visiblePrompts.map((prompt) => promptButton(prompt))}
              </div>
              <nav className="scroll-pager" aria-label="卷轴翻页">
                <button
                  type="button"
                  disabled={effectivePromptPage === 0}
                  onClick={() => setPromptPage(effectivePromptPage - 1)}
                >
                  ‹ 前一批
                </button>
                <span>
                  {prompts.length
                    ? `${effectivePromptPage * promptSize + 1}–${Math.min((effectivePromptPage + 1) * promptSize, prompts.length)} / ${prompts.length} 卷`
                    : "此筒暂无提示词"}
                </span>
                <button
                  type="button"
                  disabled={effectivePromptPage >= promptPages - 1}
                  onClick={() => setPromptPage(effectivePromptPage + 1)}
                >
                  后一批 ›
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setQuery(names.get(channelId) ?? "");
                    setPanel("search");
                  }}
                >
                  目录
                </button>
              </nav>
            </section>
          )}
          {!platform.channels.length && (
            <div className="desk-empty">
              <p>御案尚空，接入业务后即可取卷。</p>
              <button
                type="button"
                className="primary"
                onClick={() => onConfigure()}
              >
                添加第一个渠道
              </button>
            </div>
          )}
        </>
      )}
      {editing && (
        <div
          ref={editorOverlay}
          className="scroll-editor-overlay"
          tabIndex={-1}
          aria-label="展开的提示词编辑区"
          style={
            fallback
              ? undefined
              : {
                  left: layout.editor.x,
                  top: layout.editor.y,
                  width: layout.editor.width,
                  height: layout.editor.height,
                }
          }
        >
          {children}
        </div>
      )}
      {selectedKey && !editing && (
        <p className="motion-status" role="status">
          {phase === "rolling" ? "正在收卷，草稿保留在案…" : "正在展卷…"}
        </p>
      )}
      <footer className="desk-footer">
        <span>
          {platform.channels.length} 个渠道 · {platform.prompts.length} 卷
        </span>
        <span>
          {selectedKey
            ? "Esc 收卷 · 草稿随切换保留"
            : channelId
              ? "方向键选卷 · Enter 展开 · Esc 返回"
              : "Tab 切换渠道 · Enter 取卷"}
        </span>
        <span className="sync-caption">每 60 秒自动同步</span>
      </footer>
      {panel === "search" && (
        <Modal title="寻卷" onClose={() => setPanel(null)}>
          <label htmlFor="prompt-search">跨渠道搜索名称、正文或备注</label>
          <input
            autoFocus
            id="prompt-search"
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSearchPage(0);
            }}
            placeholder="输入关键词，直接展开对应卷轴"
          />
          <p className="search-count">共 {results.length} 卷</p>
          <div className="directory-list">
            {results
              .slice(effectiveSearchPage * 20, (effectiveSearchPage + 1) * 20)
              .map((prompt) => promptButton(prompt, true))}
            {!results.length && <p>没有匹配的卷轴，试试其他关键词。</p>}
          </div>
          {searchPages > 1 && (
            <nav className="directory-pager">
              <button
                type="button"
                disabled={effectiveSearchPage === 0}
                onClick={() => setSearchPage(effectiveSearchPage - 1)}
              >
                上一页
              </button>
              <span>
                {effectiveSearchPage + 1} / {searchPages}
              </span>
              <button
                type="button"
                disabled={effectiveSearchPage >= searchPages - 1}
                onClick={() => setSearchPage(effectiveSearchPage + 1)}
              >
                下一页
              </button>
            </nav>
          )}
        </Modal>
      )}
      {panel === "channels" && (
        <Modal title="渠道" onClose={() => setPanel(null)}>
          <div className="directory-list">
            {platform.channels.map((channel) => (
              <div className="channel-setting" key={channel.id}>
                <div>
                  <strong>{channel.name}</strong>
                  <p>
                    {
                      platform.prompts.filter(
                        (prompt) => prompt.channelId === channel.id,
                      ).length
                    }{" "}
                    卷 ·{" "}
                    {channel.error
                      ? "离线副本"
                      : channel.syncing
                        ? "同步中"
                        : "已连接"}
                  </p>
                  <small>最近同步 {formatTime(channel.lastSyncedAt)}</small>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setPanel(null);
                    onConfigure(channel);
                  }}
                >
                  配置
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="primary"
            onClick={() => {
              setPanel(null);
              onConfigure();
            }}
          >
            添加渠道
          </button>
        </Modal>
      )}
      {panel === "account" && (
        <Modal title="账户" onClose={() => setPanel(null)}>
          <p>管理员会话已登录。退出会清除本次未保存的草稿。</p>
          <button type="button" onClick={onLogout} disabled={loggingOut}>
            {loggingOut ? "正在退出…" : "退出登录"}
          </button>
        </Modal>
      )}
    </main>
  );
}
