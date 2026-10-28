/* global document: readonly -- page.evaluate callbacks execute in the browser. */
// Called only from ego-browser nodejs with a documented ego Page.
const normalize = s => String(s ?? '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
const topicName = s => normalize(s).replace(/^#/, '').replace(/\[话题\]#$/, '').trim();
export async function readEditor(page, config) {
  return page.evaluate(({selector, rootSelector, topicSelector}) => {
    const root = rootSelector ? document.querySelector(rootSelector)?.shadowRoot : document;
    if (!root) throw new Error('Observed shadow root is missing');
    const matches = root.querySelectorAll(selector);
    if (matches.length !== 1) throw new Error('Editor selector must match exactly one node');
    const editor = matches[0];
    const topics = topicSelector ? [...editor.querySelectorAll(topicSelector)].map(n => n.innerText || n.textContent) : [];
    const copy = editor.cloneNode(true);
    if (topicSelector) copy.querySelectorAll(topicSelector).forEach(n => n.remove());
    // Detached innerText is unreliable. Preserve block boundaries without altering the live DOM.
    copy.querySelectorAll('br').forEach(n => n.replaceWith('\n'));
    copy.querySelectorAll('p,div').forEach(n => n.append('\n'));
    return {caption: copy.textContent, topics, fullText: editor.innerText};
  }, config);
}
export async function focusEnd(page, config) {
  await page.evaluate(({selector, rootSelector}) => {
    const root = rootSelector ? document.querySelector(rootSelector)?.shadowRoot : document;
    const nodes = root?.querySelectorAll(selector);
    if (!nodes || nodes.length !== 1 || !nodes[0].isContentEditable) throw new Error('Expected one editable node');
    const e = nodes[0]; e.focus();
    const range = e.ownerDocument.createRange(); range.selectNodeContents(e); range.collapse(false);
    const selection = e.ownerDocument.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }, config);
}
export async function replaceText(page, config, caption) {
  await focusEnd(page, config);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  const empty = await readEditor(page, config);
  if (normalize(empty.fullText)) throw new Error('Clear failed; stopped before inserting duplicate text');
  await page.keyboard.insertText(caption);
  assertReadback(await readEditor(page, config), {caption, tags: []});
}
export function assertReadback(actual, expected) {
  const errors = [];
  if (normalize(actual.caption) !== normalize(expected.caption)) errors.push('caption mismatch');
  const got = (actual.topics || []).map(topicName), want = (expected.tags || []).map(topicName);
  if (got.length !== want.length || new Set(got).size !== got.length || want.some(t => !got.includes(t))) errors.push('native topic mismatch');
  if (errors.length) throw new Error(errors.join('; '));
  return {ok: true};
}
export async function waitTopics(page, config, expectedTags, timeout = 10000) {
  await page.waitForFunction(({config, tags}) => {
    const root = config.rootSelector ? document.querySelector(config.rootSelector)?.shadowRoot : document;
    const nodes = root?.querySelectorAll(config.selector);
    if (!nodes || nodes.length !== 1 || !config.topicSelector) return false;
    const norm = s => String(s).replace(/[\u200b-\u200d\ufeff]/g,'').replace(/\s+/g,' ').trim().replace(/^#/,'').replace(/\[话题\]#$/,'').trim();
    const got = [...nodes[0].querySelectorAll(config.topicSelector)].map(n=>norm(n.innerText || n.textContent));
    return tags.every(t => got.includes(norm(t)));
  }, {config, tags: expectedTags}, {timeout});
}

// 视频号的 #话题按钮负责触发平台自己的话题识别，不直接构造标签节点。
// 只用于空话题、正文已填且触发按钮已在当前页面确认的编辑器。
export async function appendTriggeredTopics(page, config, caption, tags, trigger, timeout = 10000) {
  if (!config.topicSelector || !trigger || !Array.isArray(tags) ||
      tags.some(t => typeof t !== 'string' || !t.trim() || /\s/.test(t))) {
    throw new Error('Expected a topic selector, observed trigger, and nonempty topic names');
  }
  const names = tags.map(topicName);
  if (names.some(t => !t) || new Set(names).size !== names.length) throw new Error('Invalid or duplicate topics');
  assertReadback(await readEditor(page, config), {caption, tags: []});
  await focusEnd(page, config);
  for (const [i, name] of names.entries()) {
    await page.click(trigger);
    await page.keyboard.type(name);
    await page.keyboard.press('Space');
    await waitTopics(page, config, names.slice(0, i + 1), timeout);
  }
  const result = await readEditor(page, config);
  assertReadback(result, {caption, tags: names});
  return result;
}
