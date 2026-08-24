import type { SubtitleDocument, SubtitleLine } from "./subtitle-lane.js";

/**
 * 浏览器字幕 DOM 环境（docs/phase-2-development-guide.md §8.3）。
 *
 * - 文本一律写入 textContent（文本节点），模型文本绝不进入 innerHTML；
 * - 可见性用 hidden 属性切换（支持 Reduced Motion：无动画，只有显隐）；
 * - 每 Scene 一行；remove() 从容器移除节点，不留监听。
 */
export class DomSubtitleDocument implements SubtitleDocument {
  readonly #container: HTMLElement;

  constructor(container: HTMLElement) {
    this.#container = container;
  }

  createLine(sceneId: string): SubtitleLine {
    const node = document.createElement("p");
    node.className = "stage-subtitle-line";
    node.dataset.sceneId = sceneId;
    node.hidden = true;
    this.#container.appendChild(node);
    return {
      setText: (text: string) => {
        node.textContent = text;
      },
      setVisible: (visible: boolean) => {
        node.hidden = !visible;
      },
      remove: () => {
        node.remove();
      },
    };
  }

  /** 当前可见字幕文本（E2E/UI 断言用）。 */
  visibleTexts(): readonly string[] {
    const texts: string[] = [];
    for (const node of this.#container.querySelectorAll<HTMLElement>(".stage-subtitle-line")) {
      if (!node.hidden && node.textContent !== null && node.textContent.length > 0) {
        texts.push(node.textContent);
      }
    }
    return texts;
  }
}
