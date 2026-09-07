/** Serialized into the exact user-clicked frame; deliberately closure-free. */
export function captureTarget(targetElementId: number): string | null {
  const target = browser.menus.getTargetElement(targetElementId);
  if (!target || !target.isConnected || target.ownerDocument !== document) return null;
  const excluded =
    'input,textarea,select,option,button,[contenteditable]:not([contenteditable="false"]),script,style,template,noscript';
  const visible = (element: Element): boolean => {
    let current: Element | null = element;
    let ancestors = 0;
    while (current && ++ancestors <= 100) {
      if (
        current.matches(excluded) ||
        current.hasAttribute('hidden') ||
        current.getAttribute('aria-hidden') === 'true'
      )
        return false;
      const style = getComputedStyle(current);
      if (
        style.display === 'none' ||
        style.visibility !== 'visible' ||
        Number(style.opacity) === 0 ||
        style.contentVisibility === 'hidden'
      )
        return false;
      current =
        current.parentElement ||
        (current.getRootNode() instanceof ShadowRoot
          ? (current.getRootNode() as ShadowRoot).host
          : null);
    }
    return !current;
  };
  if (!visible(target)) return null;
  const selection = window.getSelection();
  const selectedRange =
    selection && selection.rangeCount === 1 && !selection.isCollapsed
      ? selection.getRangeAt(0)
      : null;
  // Selection is optional, and only usable when completely inside the target.
  const range =
    selectedRange &&
    target.contains(selectedRange.startContainer) &&
    target.contains(selectedRange.endContainer)
      ? selectedRange
      : null;
  let text = '',
    visits = 0,
    node: Node | null = target;
  while (node && ++visits <= 2000 && text.length < 16_000) {
    const descend = !(node instanceof Element) || visible(node);
    if (
      node.nodeType === Node.TEXT_NODE &&
      node.parentElement &&
      visible(node.parentElement) &&
      (!range || range.intersectsNode(node))
    ) {
      const nodeRange = document.createRange();
      nodeRange.selectNodeContents(node);
      if (nodeRange.getClientRects().length) {
        let value = node.textContent || '';
        if (range) {
          const start = node === range.startContainer ? range.startOffset : 0;
          const end = node === range.endContainer ? range.endOffset : value.length;
          value = value.slice(start, end);
        }
        text += value.slice(0, 16_000 - text.length) + ' ';
      }
    }
    if (Array.from(text).length >= 8000) break;
    if (descend && node.firstChild) node = node.firstChild;
    else {
      while (node && node !== target && !node.nextSibling) node = node.parentNode;
      node = node && node !== target ? node.nextSibling : null;
    }
  }
  // Preserve joining characters in emoji and Indic text; remove control/bidi marks.
  return (
    Array.from(
      text
        .normalize('NFC')
        .replace(/[\p{Cc}\u00ad\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim(),
    )
      .slice(0, 500)
      .join('') || null
  );
}
