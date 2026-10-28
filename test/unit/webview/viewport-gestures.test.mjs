import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

class FakeElement extends EventTarget {
 children = [];
 style = {};
 classList = { add() {}, remove() {}, toggle() {} };
 scrollOffset = 600;
 get scrollTop() { return this.scrollOffset; }
 set scrollTop(value) { this.scrollOffset = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); }
 scrollHeight = 1000;
 clientHeight = 400;
 append(child) { this.children.push(child); }
 setPointerCapture() {}
 tagName = "div";
 closest(selectors) { return selectors.split(",").some((selector) => selector.trim() === this.tagName) ? this : null; }
}

function pointerEvent(target, type, clientY = 100, button = 0) {
 const event = new Event(type);
 Object.assign(event, { button, pointerId: 1, clientY });
 target.dispatchEvent(event);
}

function pointerDown(target, button = 0) {
 pointerEvent(target, "pointerdown", 100, button);
}

test("transcript gestures preserve reader ownership across pointer, keyboard and recovery events", async (context) => {
 const loaded = await loadBundledModule({ entry: "webview/transcript/viewport.ts", name: "viewport-gestures", platform: "browser" });
 try {
  const timers = new Map();
  let timerId = 0;
  context.mock.method(globalThis, "setTimeout", (callback) => {
   timers.set(++timerId, callback);
   return timerId;
  });
  context.mock.method(globalThis, "clearTimeout", (id) => timers.delete(id));
  const flushTimers = () => {
   const callbacks = [...timers.values()];
   timers.clear();
   for (const callback of callbacks) callback();
  };
  const globals = {
   Element: FakeElement,
   window: Object.assign(new EventTarget(), { matchMedia: () => ({ matches: true }) }),
   document: Object.assign(new EventTarget(), { hidden: false, createElement: () => new FakeElement() }),
   ResizeObserver: class { observe() {} },
  };
  for (const [name, value] of Object.entries(globals)) {
   const original = Object.getOwnPropertyDescriptor(globalThis, name);
   Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
   context.after(() => {
    if (original) Object.defineProperty(globalThis, name, original);
    else delete globalThis[name];
   });
  }
  const elements = Object.fromEntries([
   "transcript", "messages", "transcriptFrame", "jumpToBottom", "pinnedPrompt",
   "pinnedPromptText", "pinnedPromptToggle", "pinnedPromptBody",
  ].map((name) => [name, new FakeElement()]));
  let cancellations = 0;
  const { anchor } = loaded.module.createTranscriptViewport({
   elements,
   frames: { requestScrollFrame: () => 1, cancelScrollFrame() {}, scheduleMeasure() {} },
   scheduleRender() {},
   cancelSubmitFollow: () => { cancellations += 1; },
  });
  anchor.stickToBottomIfFollowing();
  for (const button of [0, 2]) {
   pointerDown(elements.transcript, button);
   assert.equal(anchor.isFollowing, true, "clicking blank space must not detach");
   elements.transcript.scrollHeight += 100;
   assert.equal(anchor.stickToBottomIfFollowing(), true);
   assert.equal(anchor.distanceFromBottomPx, 0, "subsequent output must stay visible");
  }
  assert.equal(cancellations, 2, "preserve the existing submit-follow cancellation");
  const thumb = elements.transcriptFrame.children[0].children[0];
  pointerDown(thumb);
  assert.equal(cancellations, 3);
  assert.equal(anchor.isFollowing, false, "explicit scrollbar dragging must still detach");
  elements.transcript.scrollHeight += 100;
  assert.equal(anchor.stickToBottomIfFollowing(), false);
  pointerEvent(thumb, "pointerup");
  assert.equal(anchor.isFollowing, false, "release away from the bottom stays detached");

  for (const endEvent of ["pointerup", "pointercancel", "lostpointercapture"]) {
   anchor.follow();
   anchor.stickToBottomIfFollowing();
   pointerDown(thumb);
   assert.equal(anchor.isFollowing, false);
   pointerEvent(thumb, endEvent);
   assert.equal(anchor.isFollowing, true, `${endEvent} without movement restores following`);
   elements.transcript.scrollHeight += 100;
   anchor.stickToBottomIfFollowing();
   assert.equal(anchor.distanceFromBottomPx, 0);
  }

  pointerDown(thumb);
  pointerEvent(thumb, "pointermove", 50);
  elements.transcript.dispatchEvent(new Event("scroll"));
  flushTimers();
  assert.equal(anchor.isFollowing, false, "holding the thumb in history stays detached");
  pointerEvent(thumb, "pointermove", 1000);
  elements.transcript.dispatchEvent(new Event("scroll"));
  flushTimers();
  assert.equal(anchor.isFollowing, false, "pausing at the bottom must not end a held drag");
  pointerEvent(thumb, "pointerup", 1000);
  assert.equal(anchor.isFollowing, true, "releasing at the bottom resumes following");

  pointerDown(thumb);
  pointerEvent(thumb, "pointermove", 50);
  elements.transcript.dispatchEvent(new Event("scroll"));
  pointerEvent(thumb, "pointerup", 50);
  flushTimers();
  assert.equal(anchor.isFollowing, false, "releasing in history must not resume following");
  for (const gap of [5, 20, 24]) {
   for (const endEvent of ["pointerup", "pointercancel", "lostpointercapture"]) {
    for (const scrollBeforeRelease of [false, true]) {
     anchor.follow();
     anchor.stickToBottomIfFollowing();
     elements.transcript.dispatchEvent(new Event("scroll"));
     const travel = elements.transcript.clientHeight - parseFloat(thumb.style.height);
     const range = elements.transcript.scrollHeight - elements.transcript.clientHeight;
     const pointerY = 100 - gap * travel / range;
     pointerDown(thumb);
     pointerEvent(thumb, "pointermove", pointerY);
     if (scrollBeforeRelease) elements.transcript.dispatchEvent(new Event("scroll"));
     pointerEvent(thumb, endEvent, pointerY);
     elements.transcript.dispatchEvent(new Event("scroll"));
     flushTimers();
     assert.equal(anchor.isFollowing, false, `${gap}px upward drag stays detached after ${endEvent} (scroll before release: ${scrollBeforeRelease})`);
     assert.ok(Math.abs(anchor.distanceFromBottomPx - gap) < 0.001, "release must preserve the reader's position");
    }
   }
  }
  for (const leave of ["blur", "hidden"]) {
   for (const gesture of ["none", "wheel", "touch"]) {
    anchor.follow();
    anchor.stickToBottomIfFollowing();
    if (leave === "blur") window.dispatchEvent(new Event("blur"));
    else {
     document.hidden = true;
     document.dispatchEvent(new Event("visibilitychange"));
    }
    elements.transcript.scrollHeight += 100;
    elements.transcript.scrollTop -= 20;
    elements.transcript.dispatchEvent(new Event("scroll"));
    assert.equal(anchor.isFollowing, true, "background layout must preserve follow intent");
    if (gesture === "wheel") {
     const event = new Event("wheel");
     Object.assign(event, { deltaY: -20 });
     elements.transcript.dispatchEvent(event);
    } else if (gesture === "touch") {
     for (const [type, clientY] of [["touchstart", 100], ["touchmove", 120]]) {
      const event = new Event(type);
      Object.assign(event, { touches: [{ clientY }] });
      elements.transcript.dispatchEvent(event);
     }
     elements.transcript.dispatchEvent(new Event("touchend"));
    }
    const readerTop = elements.transcript.scrollTop;
    if (leave === "hidden") {
     document.hidden = false;
     document.dispatchEvent(new Event("visibilitychange"));
    }
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    flushTimers();
    anchor.stickToBottomIfFollowing();
    assert.equal(anchor.isFollowing, gesture === "none", `${leave}/${gesture}`);
    if (gesture === "none") assert.equal(anchor.distanceFromBottomPx, 0);
    else assert.equal(elements.transcript.scrollTop, readerTop);
   }
  }
  for (const tagName of ["div", "button", "input", "textarea", "select", "[contenteditable]"]) {
   for (const key of ["ArrowUp", "PageUp", "Home", "ArrowDown", "PageDown", "End", " ", "Enter"]) {
    for (const shiftKey of [false, true]) {
     for (const prevented of [false, true]) {
      anchor.follow({ smooth: true });
      elements.transcript.scrollTop = 100;
      const target = new FakeElement();
      target.tagName = tagName;
      const event = new Event("keydown", { cancelable: true });
      Object.defineProperty(event, "target", { value: target });
      Object.assign(event, { key, shiftKey });
      if (prevented) event.preventDefault();
      const before = cancellations;
      elements.transcript.dispatchEvent(event);
      const shouldDetach = !prevented && ["div", "button"].includes(tagName)
       && key !== "Enter" && !(tagName === "button" && key === " ");
      const label = `${tagName}/${key}/shift=${shiftKey}/prevented=${prevented}`;
      assert.equal(anchor.isFollowing, !shouldDetach, label);
      assert.equal(cancellations - before, shouldDetach ? 1 : 0, label);
      flushTimers();
     }
    }
   }
  }
 } finally { await loaded.dispose(); }
});
