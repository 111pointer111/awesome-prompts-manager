import { Component, StrictMode } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(_error: Error, _info: ErrorInfo) { console.error("Interface rendering failed"); }
  render() {
    if (this.state.failed) return <main className="loading-page"><h1>页面暂时无法显示</h1><p>重新加载页面后再试。未保存的输入可能需要重新填写。</p><button type="button" onClick={() => window.location.reload()}>重新加载</button></main>;
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(<StrictMode><ErrorBoundary><App /></ErrorBoundary></StrictMode>);
