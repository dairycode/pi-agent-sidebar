import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

for (const inactive of [false, true]) {
 test(`smooth follow survives reflow and keeps easing (inactive: ${inactive})`, async () => {
  const loaded = await loadBundledModule({ entry: "webview/transcript/scrollAnchor.ts", name: "smooth-follow", platform: "browser" });
  try {
   const viewport = { scrollTop: 100, scrollHeight: 1600, clientHeight: 400 };
   let nextFrame;
   const anchor = new loaded.module.ScrollAnchor({
    viewport,
    requestFrame: (callback) => { nextFrame = callback; return 1; },
    cancelFrame: () => { nextFrame = undefined; },
   });
   anchor.follow({ smooth: true });
   if (inactive) anchor.suspend();
   anchor.stickToBottomIfFollowing();
   assert.ok(viewport.scrollTop > 100 && viewport.scrollTop < 1200);
   viewport.scrollTop += 20;
   anchor.noteScroll();
   viewport.scrollTop += 20;
   anchor.noteScroll();
   // Reflow without a render/scroll event must also retarget the animation.
   viewport.scrollHeight += 300;
   viewport.clientHeight += 50;
   for (let frame = 0; nextFrame && frame < 240; frame += 1) {
    const callback = nextFrame;
    nextFrame = undefined;
    callback(frame * 16.67);
   }
   assert.equal(nextFrame, undefined);
   assert.equal(anchor.distanceFromBottomPx, 0);
   assert.equal(anchor.isFollowing, true);
   const previousTop = viewport.scrollTop;
   viewport.scrollHeight += 200;
   anchor.stickToBottomIfFollowing();
   assert.ok(viewport.scrollTop > previousTop && anchor.distanceFromBottomPx > 0);
   assert.ok(nextFrame, "subsequent streaming must remain animated");
   anchor.noteUserIntent(-1);
   assert.equal(nextFrame, undefined);
   assert.equal(anchor.stickToBottomIfFollowing(), false);
  } finally { await loaded.dispose(); }
 });
}
