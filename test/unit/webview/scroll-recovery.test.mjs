import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function withAnchor(run) {
 const loaded = await loadBundledModule({ entry: "webview/transcript/scrollAnchor.ts", name: "scroll-recovery", platform: "browser" });
 try {
  const viewport = { scrollTop: 600, scrollHeight: 1000, clientHeight: 400 };
  let nextFrame;
  const anchor = new loaded.module.ScrollAnchor({
   viewport,
   requestFrame: (callback) => { nextFrame = callback; return 1; },
   cancelFrame: () => { nextFrame = undefined; },
  });
  const drainFrames = () => {
   for (let index = 0; nextFrame && index < 240; index += 1) {
    const callback = nextFrame;
    nextFrame = undefined;
    callback(index * 16.67);
   }
   assert.equal(nextFrame, undefined, "animation must settle");
  };
  await run({ anchor, viewport, hasFrame: () => Boolean(nextFrame), drainFrames });
 } finally { await loaded.dispose(); }
}

test("immediate follow survives pre-render layout scrolls and then resumes easing", async () => {
 await withAnchor(({ anchor, viewport, hasFrame }) => {
  anchor.detach();
  viewport.scrollTop = 100;
  anchor.follow({ immediate: true });
  viewport.scrollTop = 120;
  assert.equal(anchor.noteScroll(), false);
  viewport.scrollHeight = 1800;
  viewport.clientHeight = 500;
  anchor.stickToBottomIfFollowing();
  assert.equal(viewport.scrollTop, 1300);
  assert.equal(hasFrame(), false);
  assert.equal(anchor.noteScroll(), false);
  viewport.scrollHeight = 2000;
  anchor.stickToBottomIfFollowing();
  assert.ok(viewport.scrollTop > 1300 && viewport.scrollTop < 1500);
  assert.equal(hasFrame(), true);
 });
});

test("background layout cannot detach following and duplicate resume is harmless", async () => {
 await withAnchor(({ anchor, viewport, hasFrame }) => {
  viewport.scrollHeight = 1400;
  anchor.stickToBottomIfFollowing();
  assert.equal(hasFrame(), true);
  anchor.suspend();
  assert.equal(hasFrame(), true);
  viewport.scrollTop = 200;
  anchor.noteScroll();
  viewport.scrollTop = 250;
  anchor.noteScroll();
  assert.equal(anchor.isFollowing, true);
  assert.equal(anchor.resume(), true);
  assert.equal(anchor.resume(), false);
  viewport.scrollTop = 300;
  anchor.noteScroll();
  anchor.stickToBottomIfFollowing();
  assert.equal(viewport.scrollTop, 1000);
 });
});

for (const gap of [5, 20, 24]) {
 for (const observeBackgroundScroll of [false, true]) {
  test(`upward ${gap}px gesture after background follow stays detached (scroll event: ${observeBackgroundScroll})`, async () => {
   await withAnchor(({ anchor, viewport, drainFrames }) => {
    anchor.noteScroll();
    anchor.suspend();
    viewport.scrollHeight += 100;
    anchor.stickToBottomIfFollowing();
    drainFrames();
    if (observeBackgroundScroll) anchor.noteScroll();
    assert.equal(viewport.scrollTop, 700);

    anchor.noteUserIntent(-gap);
    viewport.scrollTop -= gap;
    anchor.noteScroll();
    assert.equal(anchor.finishUserScroll(), false);
    assert.equal(anchor.resume(), false);
    assert.equal(anchor.stickToBottomIfFollowing(), false);
    assert.equal(viewport.scrollTop, 700 - gap);
   });
  });
 }
}

for (const phase of ["background", "pending pin"]) {
 test(`reader input cancels recovery during ${phase}`, async () => {
  await withAnchor(({ anchor, viewport }) => {
   anchor.suspend();
   if (phase === "pending pin") anchor.resume();
   anchor.noteUserIntent(-1);
   viewport.scrollTop = 300;
   anchor.noteScroll();
   anchor.finishUserScroll();
   assert.equal(anchor.resume(), false);
   assert.equal(anchor.stickToBottomIfFollowing(), false);
   assert.equal(viewport.scrollTop, 300);
  });
 });
}

test("history reading and explicit detach survive leave and return", async () => {
 await withAnchor(({ anchor, viewport }) => {
  anchor.detach();
  viewport.scrollTop = 100;
  anchor.suspend();
  viewport.scrollHeight = 2000;
  assert.equal(anchor.resume(), false);
  assert.equal(anchor.stickToBottomIfFollowing(), false);
  assert.equal(viewport.scrollTop, 100);
  anchor.follow({ immediate: true });
  anchor.detach();
  assert.equal(anchor.stickToBottomIfFollowing(), false);
 });
});

for (const echoFirst of [true, false]) {
 test(`submit eases across acknowledgement and composer resize (echo first: ${echoFirst})`, async () => {
  const loaded = await loadBundledModule({ entry: "webview/transcript/submitFollow.ts", name: "submit-recovery" });
  try {
   await withAnchor(({ anchor, viewport, hasFrame, drainFrames }) => {
    const coordinator = new loaded.module.SubmitFollowCoordinator({ onFollow: () => anchor.follow({ smooth: true }) });
    anchor.detach();
    viewport.scrollTop = 100;
    coordinator.start("send", "hello", 120);
    const echo = () => { viewport.scrollHeight += 200; coordinator.noteUserMessage("hello"); };
    const acknowledge = () => { viewport.clientHeight += 80; coordinator.settleAction("send", true, 40); };
    for (const update of echoFirst ? [echo, acknowledge] : [acknowledge, echo]) {
     update();
     viewport.scrollTop += 10;
     anchor.noteScroll();
     anchor.stickToBottomIfFollowing();
     assert.ok(anchor.distanceFromBottomPx > 0);
     assert.equal(hasFrame(), true);
    }
    viewport.clientHeight += 20;
    coordinator.noteComposerResize();
    anchor.stickToBottomIfFollowing();
    drainFrames();
    assert.equal(anchor.distanceFromBottomPx, 0);
   });
  } finally { await loaded.dispose(); }
 });
}
