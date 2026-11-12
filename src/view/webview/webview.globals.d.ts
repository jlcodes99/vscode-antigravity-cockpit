/**
 * Webview DOM 胶水层类型。
 *
 * 遗留 JS 代码大量直接访问 getElementById(...).value/.checked/.disabled 等
 * 表单元素属性（标准 lib 返回宽泛的 HTMLElement）。这里收窄为常用元素的
 * 交集类型——仍是具体类型而非 any：访问未声明的属性名仍会报错，
 * 拼写错误与真缺失属性不会被放过。
 */

type InteractedElement = HTMLElement & {
    // 表单元素常用属性（各 HTML*Element 的 type 字面量冲突，交集写法会退化为 never，故直接展开）
    value: string;
    checked: boolean;
    disabled: boolean;
    files: FileList | null;
    type: string;
    select(): void;
    // img
    src: string;
    alt: string;
    // template.content
    content: InteractedElement;
};

interface Document {
    getElementById(elementId: string): InteractedElement | null;
    createElement(tagName: string): InteractedElement;
    querySelector<E extends Element = InteractedElement>(selectors: string): E | null;
}

interface ParentNode {
    querySelector<E extends Element = InteractedElement>(selectors: string): E | null;
    querySelectorAll<E extends Element = InteractedElement>(selectors: string): NodeListOf<E>;
}

// 事件委托代码统一从 e.target 访问 dataset/classList/closest/表单属性。
// 标准 lib 中 Event.target 仅 EventTarget、Element 不含 dataset/style，
// 遗留胶水代码按"事件目标均为可交互 HTML 元素"使用，此处统一补齐；
// 属性名仍受声明约束，拼写错误/真缺失属性会报错。
interface EventTarget {
    value: string;
    checked: boolean;
    disabled: boolean;
    dataset: DOMStringMap;
    classList: DOMTokenList;
    style: CSSStyleDeclaration;
    tagName: string;
    closest(selectors: string): InteractedElement | null;
    getAttribute(qualifiedName: string): string | null;
    offsetWidth: number;
}

interface Element {
    dataset: DOMStringMap;
    style: CSSStyleDeclaration;
    offsetWidth: number;
}

interface VsCodeWebviewApi {
    postMessage(message: unknown): Thenable<boolean> | void;
    getState<T = Record<string, unknown>>(): T | undefined;
    setState<T>(state: T): T;
}

declare function acquireVsCodeApi(): VsCodeWebviewApi;

/** auth_ui.js 暴露给其他 bundle 使用的句柄（仅声明跨模块实际调用的方法） */
interface AuthUiHandle {
    updateState: (...args: unknown[]) => void;
    renderAuthRow: (...args: unknown[]) => void;
    renderAccountManageList: () => void;
    openAccountManageModal: () => void;
}

interface AntigravityAuthUIClass {
    new(vscode: VsCodeWebviewApi): AuthUiHandle;
}

interface Window {
    /** hud.ts 注入的翻译字典 */
    __i18n?: Record<string, string>;
    __autoTriggerI18n?: Record<string, string>;
    __accountsOverviewI18n?: Record<string, string>;
    /** 缓存的 VS Code webview API（多个 bundle 共享单例） */
    __vscodeApi?: VsCodeWebviewApi;
    /** auth_ui.js 暴露的授权 UI 类 */
    AntigravityAuthUI?: AntigravityAuthUIClass;
    __authUi?: AuthUiHandle | null;
    __autoTriggerI?: unknown;
    __accountsOverviewI?: unknown;
    /** auto_trigger.js 暴露给内联 onclick 的句柄 */
    AutoTriggerTab?: unknown;

    // 内联 HTML 事件处理器调用的全局函数（由各 bundle 挂到 window）
    retryConnection?: () => void;
    openLogs?: () => void;
    openAccountManageModal?: (email?: string) => void;
    openRevokeModalForEmail?: (email?: string) => void;
    showLocalAuthImportLoading?: (show?: boolean) => void;
    showImagePreview?: (src: string) => void;
}
