/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui/webUi-sparkline.mjs: A store-free SVG sparkline trend strip for plugin webUIs.
 */

/**
 * A domain-ignorant trend strip: numbers in, a one-color SVG out.
 *
 * The primitive owns the mechanism and nothing else. It takes a window of numbers, projects it onto a fixed drawing grid, and renders an area, a line, an end dot,
 * and a zero hairline, with a cursor hairline and a cursor dot at the sample under the pointer for a consumer that scrubs - all in `currentColor`, so the strip
 * wears whatever color the markup around it wears and the two can never disagree. Every policy stays with the consumer: what the numbers mean, where they come
 * from, how often they arrive, what color the surrounding element carries, whether an update slides, what the accessible label says, whether a pointer scrubs the
 * strip at all, and how a scrubbed sample's readout is worded and where it is shown. The module holds no store and subscribes to nothing beyond its own element;
 * its one dependency is the webUI's shared SVG element builder, which every graphic in the tree draws through.
 *
 * A consumer composes it into a panel it owns:
 *
 * ```js
 * const strip = createSparkline({ ariaLabel: "Prices over the last hour.", domainAnchor: 14, points: history });
 *
 * tile.append(strip.element);
 * strip.update({ points: nextHistory, slide: true });
 * ```
 *
 * @module
 */
"use strict";

import { createSvgElement } from "./webUi-svg.mjs";

// The strip's drawing grid. The consumer sizes and positions the element with its own CSS and the viewBox stretches to fill it, so these are aspect-free coordinate
// units rather than pixels on screen.
const VIEW_WIDTH = 600;
const VIEW_HEIGHT = 64;
const VIEW_BOX = "0 0 " + String(VIEW_WIDTH) + " " + String(VIEW_HEIGHT);

// The plot's left inset. The oldest sample's dot, and the scrub cursor's dot when it rests on that sample, sit at the left edge of the plot, so the plot starts in
// from the viewBox edge by enough room for the dot and its ring to render whole rather than clipped in half.
const LEFT_INSET = 8;

// The plot's right inset. The newest sample's dot sits at the right edge of the plot, so the plot stops short of the viewBox edge by enough room for the dot and
// its ring to render whole rather than clipped in half.
const RIGHT_INSET = 8;
const PLOT_WIDTH = VIEW_WIDTH - LEFT_INSET - RIGHT_INSET;

// The headroom reserved above the domain's top value, so the highest sample's line cap and dot are not shaved off by the top edge.
const TOP_PAD = 7;
const PLOT_HEIGHT = VIEW_HEIGHT - TOP_PAD;

// The area fill's opacity. Faint enough that the fill reads as a tint of the line's color rather than as a second color statement competing with the value the
// strip sits under.
const AREA_FILL_OPACITY = 0.12;

// The zero hairline's stroke opacity, and the stroke width it shares with the scrub cursor's hairline. The zero hairline is a reference mark, not data, so it
// renders as a faint tint of the same color the data wears.
const HAIRLINE_OPACITY = 0.4;
const HAIRLINE_WIDTH = 1;

// The scrub cursor's stroke opacity. Stronger than the zero hairline's, because the cursor marks the sample the reader is pointing at rather than a reference, and
// still a tint of the data's own color so it never reads as a second data line.
const CURSOR_OPACITY = 0.6;

// The data line's stroke width. Non-scaling, so the line keeps this weight no matter how far the viewBox is stretched by the consumer's sizing.
const LINE_WIDTH = 2;

// The radius of the end dot and of the scrub cursor's dot, and the width of the ring that separates each from the line beneath it. The ring strokes the library's
// own surface token, falling back to the CSS system canvas color, because its job is to read as a punch-out of the page surface rather than as a color of its own.
const DOT_RADIUS = 4;
const DOT_RING_COLOR = "var(--fo-surface-bg, Canvas)";
const DOT_RING_WIDTH = 2;

// The conveyor slide's duration and easing. Long enough to read as motion carrying the window forward, short enough that it never delays the eye from the settled
// state, with an ease that starts and ends gently.
const SLIDE_DURATION_MS = 400;
const SLIDE_EASING = "cubic-bezier(0.25, 0.1, 0.25, 1)";

// How far past the slide's nominal end the fallback settle waits before landing the strip itself. It only ever runs when the transition's own completion event
// never arrives - a detached element, a host that suppressed the transition, a dropped event - so the margin just has to clear normal event delivery.
const SETTLE_FALLBACK_MARGIN_MS = 60;

// The decimal places coordinates are written to. COORDINATE_PRECISION is far below a rendered pixel at any strip size, and it keeps the path attributes short
// enough to read while debugging.
const COORDINATE_PRECISION = 2;

/**
 * The direction a window of numbers is moving in.
 *
 * @typedef {"falling" | "rising" | "steady"} TrendDirection
 */

/**
 * The vertical scale one paint is drawn against.
 *
 * @typedef {Object} SparklineDomain
 * @property {number} min - The value that lands on the strip's bottom edge.
 * @property {number} span - The value range the plot height covers. Guaranteed greater than zero, so it is always safe to divide by.
 */

/**
 * The sample under a scrubbing pointer.
 *
 * @typedef {Object} SparklineScrubSample
 * @property {number} index - The sample's position in the normalized window, oldest sample first. A consumer whose window is all finite can index a parallel array
 *                            of per-sample metadata with it directly.
 * @property {number} value - The sample's value, in the caller's own units.
 */

/**
 * The options a strip is constructed with.
 *
 * @typedef {Object} SparklineOptions
 * @property {string} [ariaLabel=""] - The strip's accessible label. Written only when it is a string; the consumer owns the wording and updates it through
 *                                     {@link SparklineUpdateOptions.ariaLabel} as the data changes.
 * @property {number} [domainAnchor] - A floor for the top of the value domain, in the caller's own units. A window whose values all sit well below it renders low
 *                                     in the strip rather than filling it, so height carries absolute meaning; data above it still scales to the data's own
 *                                     maximum and is never clipped. Ignored unless finite. Fixed for the instance's life by design: a consumer whose anchor
 *                                     changes builds a new strip rather than re-anchoring this one, which keeps every repaint free of a whole-scale reset the
 *                                     slide would have to reason about.
 * @property {(sample: SparklineScrubSample | null) => void} [onScrub] - Wire pointer scrubbing, which a strip carries only when this is a function. A pointer
 *                                                                       over the strip snaps to the nearest sample, the strip draws a cursor hairline and
 *                                                                       dot there, and the consumer draws the readout. The callback receives the sample when
 *                                                                       a pointer moves onto a different one and after every settled repaint under a held
 *                                                                       pointer, because a repaint can put a different sample at the same index; null when
 *                                                                       the pointer leaves or the window empties under it; and no sample while a slide is in
 *                                                                       flight, the last report holding until the slide settles. The mapping reads the
 *                                                                       element's border box, so the consumer sizes the strip with no padding and no border.
 *                                                                       A throw from the callback propagates untouched: the strip's own state is final
 *                                                                       before the call, and the throw reaches the consumer through its own update call or
 *                                                                       through the browser's reporting of an event listener or timer error.
 * @property {number[]} [points=[]] - The initial window, oldest sample first. Null and non-finite elements are dropped before any geometry is computed.
 */

/**
 * The options one repaint is driven with.
 *
 * @typedef {Object} SparklineUpdateOptions
 * @property {string} [ariaLabel] - A replacement accessible label. Only a string replaces the current label; omitted, null, and non-string values leave whatever
 *                                  label the strip already carries untouched, so a caller updating data alone need not restate it.
 * @property {number[]} points - The new window, oldest sample first. Null and non-finite elements are dropped before any geometry is computed.
 * @property {boolean} [slide=false] - Request the conveyor animation. Honored only when the new window is the previous one advanced by exactly one sample and the
 *                                     host is not asking for reduced motion; every other shape repaints instantly.
 */

/**
 * A constructed strip.
 *
 * @typedef {Object} Sparkline
 * @property {SVGSVGElement} element - The strip's root element, ready to be placed and sized by the consumer. It inherits its color from whatever it is placed in.
 * @property {(options: SparklineUpdateOptions) => void} update - Repaint the same element with a new window.
 */

/**
 * The options {@link trendDirection} reads.
 *
 * @typedef {Object} TrendDirectionOptions
 * @property {number} [deadband=0] - The magnitude of change to treat as no change, in the caller's own units. Non-finite and negative values read as zero.
 * @property {number[]} points - The window to read, oldest sample first.
 */

// Reduce a caller's window to the numbers the geometry can actually draw. Null and undefined read as an empty window, and every non-finite element - NaN, Infinity,
// and anything that is not a number at all - drops out here. Both entry points and the trend helper normalize through this one function, so no surface can
// disagree with another about what a window is, and no caller value can reach an attribute as "NaN".
const normalizePoints = (points) => (points ?? []).filter(Number.isFinite);

// Format a coordinate for an SVG attribute.
const coordinate = (value) => value.toFixed(COORDINATE_PRECISION);

/**
 * Compute the vertical scale for a window.
 *
 * The accumulators start at zero rather than at the data's own extremes, and that is what makes the domain zero-inclusive for every possible input: zero always
 * sits inside the domain or exactly at one of its edges. An all-positive window puts zero at the baseline, a window that dips puts it somewhere in the middle, and
 * an all-negative window puts it at the top - so the zero hairline and the area's close to it are on-canvas in every case, with no special-casing anywhere else.
 *
 * A finite anchor raises the top only. It cannot lower it, so a spike above the anchor still scales to the data's own maximum instead of clipping.
 *
 * The span is guarded because it divides. The only window that can collapse it is one whose values and effective top are all exactly zero; a span of one puts every
 * such point on the baseline rather than at NaN.
 *
 * @param {Object} options - The domain inputs.
 * @param {number} [options.anchor] - The domain-top floor, honored only when finite.
 * @param {number[]} options.points - The normalized window.
 * @returns {SparklineDomain} The scale to project against.
 */
const domainFor = ({ anchor, points }) => {

  let dataMax = 0;
  let dataMin = 0;

  for(const value of points) {

    if(value > dataMax) {

      dataMax = value;
    }

    if(value < dataMin) {

      dataMin = value;
    }
  }

  const max = (Number.isFinite(anchor) && (anchor > dataMax)) ? anchor : dataMax;
  const span = max - dataMin;

  return { min: dataMin, span: (span > 0) ? span : 1 };
};

/**
 * Project a value onto the strip's vertical axis. The domain's minimum lands on the bottom edge and its maximum lands one top pad below the top edge.
 *
 * @param {Object} options - The projection inputs.
 * @param {SparklineDomain} options.domain - The scale to project against.
 * @param {number} options.value - The value to place.
 * @returns {number} The y coordinate, in viewBox units.
 */
const yFor = ({ domain, value }) => VIEW_HEIGHT - (((value - domain.min) / domain.span) * PLOT_HEIGHT);

/**
 * The horizontal distance between adjacent samples for a window of a given size. A window that cannot be drawn as a line has no meaningful step.
 *
 * @param {number} count - The number of points in the window being drawn.
 * @returns {number} The step, in viewBox units, or zero for a window of fewer than two points.
 */
const stepFor = (count) => (count > 1) ? (PLOT_WIDTH / (count - 1)) : 0;

/**
 * Place a sample on the strip's horizontal axis. The oldest sample lands on the plot's left edge and each later one a step further right, which at a window's own
 * step puts the newest on the plot's right edge. A lone sample has no step to space it by, so it sits at the plot's right edge, the position every window's newest
 * sample occupies. Every mark placed on a sample takes its x from here, so a cursor on the newest sample lands exactly on the end dot.
 *
 * @param {Object} options - The placement inputs.
 * @param {number} options.count - The number of points in the window being drawn.
 * @param {number} options.index - The sample's position in that window, oldest sample first.
 * @param {number} options.step - The horizontal distance between adjacent points, in viewBox units.
 * @returns {number} The x coordinate, in viewBox units.
 */
const sampleX = ({ count, index, step }) => (count === 1) ? (VIEW_WIDTH - RIGHT_INSET) : (LEFT_INSET + (index * step));

/**
 * Build the line and area path data for a window.
 *
 * The line is a polyline through every point. The area is that same polyline closed down to the zero line rather than to the strip's bottom edge, so a stretch of
 * negative values fills upward between the line and zero instead of flooding the whole strip.
 *
 * @param {Object} options - The path inputs.
 * @param {SparklineDomain} options.domain - The scale to project against.
 * @param {number[]} options.points - The normalized window, two points or more.
 * @param {number} options.step - The horizontal distance between adjacent points, in viewBox units.
 * @returns {{ area: string, line: string }} The two `d` attribute values.
 */
const pathsFor = ({ domain, points, step }) => {

  const commands = [];
  const count = points.length;

  for(const [ index, value ] of points.entries()) {

    commands.push(((index === 0) ? "M" : "L") + coordinate(sampleX({ count, index, step })) + "," + coordinate(yFor({ domain, value })));
  }

  const line = commands.join(" ");
  const firstX = coordinate(sampleX({ count, index: 0, step }));
  const lastX = coordinate(sampleX({ count, index: count - 1, step }));
  const zeroY = coordinate(yFor({ domain, value: 0 }));

  return { area: line + " L" + lastX + "," + zeroY + " L" + firstX + "," + zeroY + " Z", line };
};

/**
 * Decide whether a window is the previous one advanced by exactly one sample - the only shape the conveyor slide can honestly animate.
 *
 * Every overlapping element is compared rather than just the endpoints. An endpoint-only check would accept a window whose interior had changed and animate a slide
 * that misrepresents the data; a sparkline window is a handful of numbers, so the full comparison costs nothing worth saving.
 *
 * @param {Object} options - The two windows to compare, both normalized.
 * @param {number[]} options.next - The incoming window.
 * @param {number[]} options.previous - The window currently rendered.
 * @returns {boolean} True when every overlapping sample matches and the shift is exactly one.
 */
const isOneStepShift = ({ next, previous }) => {

  if((next.length !== previous.length) || (next.length < 2)) {

    return false;
  }

  for(let index = 0; index < (next.length - 1); index++) {

    if(next[index] !== previous[index + 1]) {

      return false;
    }
  }

  return true;
};

// Read the host's motion preference. Qualified with `window` and optional-chained so a host that provides no matchMedia reads as no preference and animates,
// rather than throwing. The read happens at each update rather than once at construction: the preference can change under the user mid-session, and a page-level
// reduced-motion stylesheet is not the only way a host expresses it - asking the media query directly keeps the strip correct in any host, not just this library's.
const prefersReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * Build a sparkline trend strip.
 *
 * The returned element is markup the consumer places, sizes, and colors: it draws in `currentColor`, so setting a color anywhere up the tree colors the whole strip.
 * Built without {@link SparklineOptions.onScrub} it is inert markup that answers no pointer; built with one, it also listens for pointers on itself alone and hands
 * the sample under one to that callback. Everything else after construction happens through {@link Sparkline.update}, which mutates the same element and the same
 * marks in place - no element is ever replaced, so a consumer can hold the reference for the life of its panel.
 *
 * @param {SparklineOptions} options - The strip's construction options.
 * @returns {Sparkline} The element and its update function.
 */
export function createSparkline({ ariaLabel = "", domainAnchor = undefined, onScrub = undefined, points: initialPoints = [] }) {

  const element = createSvgElement({ attributes: { preserveAspectRatio: "none", role: "img", viewBox: VIEW_BOX }, tag: "svg" });

  element.style.overflow = "hidden";

  // The zero reference, drawn across the full width outside the sliding group so it stays put while the data moves under it.
  const hairline = createSvgElement({

    attributes: {

      "stroke": "currentColor",
      "stroke-opacity": String(HAIRLINE_OPACITY),
      "stroke-width": String(HAIRLINE_WIDTH),
      "vector-effect": "non-scaling-stroke",
      "visibility": "hidden",
      "x1": "0",
      "x2": String(VIEW_WIDTH),
      "y1": "0",
      "y2": "0"
    },
    tag: "line"
  });

  // The data marks and the group that carries them. The group exists so the conveyor slide can translate them all with one transform.
  const areaPath = createSvgElement({ attributes: { "d": "", "fill": "currentColor", "fill-opacity": String(AREA_FILL_OPACITY), "stroke": "none" }, tag: "path" });
  const linePath = createSvgElement({

    attributes: {

      "d": "",
      "fill": "none",
      "stroke": "currentColor",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "stroke-width": String(LINE_WIDTH),
      "vector-effect": "non-scaling-stroke"
    },
    tag: "path"
  });

  const endDot = createSvgElement({

    attributes: {

      "fill": "currentColor",
      "r": String(DOT_RADIUS),
      "stroke": DOT_RING_COLOR,
      "stroke-width": String(DOT_RING_WIDTH),
      "visibility": "hidden"
    },
    tag: "circle"
  });

  const slideGroup = createSvgElement({ tag: "g" });

  slideGroup.append(areaPath, linePath, endDot);
  element.append(hairline, slideGroup);

  // The window currently rendered, normalized. The slide's shape check reads it, so it is the normalized form that is remembered rather than what the caller handed
  // over.
  let currentPoints = normalizePoints(initialPoints);

  // The slide in flight, or null. One record holds both settle mechanisms together so they are armed and torn down as a unit.
  let pendingSlide = null;

  // Write the accessible label, but only for an actual string. A caller updating data alone omits it, and a null or non-string value is treated the same way, so a
  // sloppy caller cannot silently blank out a label that was set correctly earlier.
  const applyAriaLabel = (label) => {

    if(typeof label === "string") {

      element.setAttribute("aria-label", label);
    }
  };

  /**
   * Repaint the marks for a window at a given horizontal step.
   *
   * Both the settled window and the slide's union window come through here. The caller owns the step, which is what lets the union be drawn at the settled window's
   * spacing, and the domain is always computed over exactly the points being drawn.
   *
   * @param {Object} options - The paint inputs.
   * @param {number[]} options.points - The normalized window to draw.
   * @param {number} options.step - The horizontal distance between adjacent points, in viewBox units.
   * @returns {void}
   */
  const paint = ({ points, step }) => {

    const count = points.length;

    // Nothing to draw: clear the paths rather than leaving the last window's shape stranded on screen, and take both markers down with them.
    if(count === 0) {

      areaPath.setAttribute("d", "");
      linePath.setAttribute("d", "");
      endDot.setAttribute("visibility", "hidden");
      hairline.setAttribute("visibility", "hidden");

      return;
    }

    const domain = domainFor({ anchor: domainAnchor, points });

    endDot.setAttribute("visibility", "visible");

    // A lone sample has no line to draw, so the dot carries it alone.
    if(count === 1) {

      areaPath.setAttribute("d", "");
      linePath.setAttribute("d", "");
    } else {

      const { area, line } = pathsFor({ domain, points, step });

      areaPath.setAttribute("d", area);
      linePath.setAttribute("d", line);
    }

    endDot.setAttribute("cx", coordinate(sampleX({ count, index: count - 1, step })));
    endDot.setAttribute("cy", coordinate(yFor({ domain, value: points[count - 1] })));

    // The hairline marks zero only for a window that actually dips below it. A window that never goes negative has zero sitting at its baseline, where a hairline
    // would just underline the bottom of the strip.
    const crossesZero = domain.min < 0;

    hairline.setAttribute("visibility", crossesZero ? "visible" : "hidden");

    if(crossesZero) {

      const zeroY = coordinate(yFor({ domain, value: 0 }));

      hairline.setAttribute("y1", zeroY);
      hairline.setAttribute("y2", zeroY);
    }
  };

  // Tear down whichever slide is in flight, listener and timer together, and report whether there was one. Both settle mechanisms race by design, so whichever
  // arrives second finds the record gone, reads false, and stops - it can never repaint over a window that has moved on without it.
  const clearPendingSlide = () => {

    if(!pendingSlide) {

      return false;
    }

    slideGroup.removeEventListener("transitionend", pendingSlide.listener);
    clearTimeout(pendingSlide.timer);
    pendingSlide = null;

    return true;
  };

  /**
   * Wire pointer scrubbing onto the strip: the cursor marks, the touch rule, the pointer listeners, and the state they share.
   *
   * The strip owns the geometry only it knows - which sample is nearest a pointer and where that sample's dot sits - and hands the consumer the one fact the consumer
   * cannot know, the sample itself, so the readout's wording and placement stay with the consumer. Text never enters the SVG: the viewBox stretches to the
   * consumer's box with `preserveAspectRatio` set to none, so a glyph drawn inside it would stretch with the strip.
   *
   * @returns {(options: { repaint: boolean }) => void} The resolve each settled repaint runs, so a held pointer follows the window as it changes.
   */
  const wireScrub = () => {

    // The cursor marks, appended after the sliding group so they draw above the data and stay put while the group translates beneath them.
    const cursorLine = createSvgElement({

      attributes: {

        "stroke": "currentColor",
        "stroke-opacity": String(CURSOR_OPACITY),
        "stroke-width": String(HAIRLINE_WIDTH),
        "vector-effect": "non-scaling-stroke",
        "visibility": "hidden",
        "y1": "0",
        "y2": String(VIEW_HEIGHT)
      },
      tag: "line"
    });

    const cursorDot = createSvgElement({

      attributes: {

        "fill": "currentColor",
        "r": String(DOT_RADIUS),
        "stroke": DOT_RING_COLOR,
        "stroke-width": String(DOT_RING_WIDTH),
        "visibility": "hidden"
      },
      tag: "circle"
    });

    element.append(cursorLine, cursorDot);

    // A horizontal drag scrubs while a vertical one still scrolls the page and a pinch still zooms it. The browser decides which gesture a touch is, and a pan or a
    // zoom it takes over ends the scrub with a pointercancel.
    element.style.touchAction = "pan-y pinch-zoom";

    // The scrub's whole state: the pointer's last position in viewBox units while it is over the strip, and the sample last handed to the consumer. The position is
    // what is remembered rather than the index, because a repaint that resizes the window puts a different sample under the same pointer.
    const scrub = { pointerX: null, reported: null };

    const hideCursor = () => {

      cursorLine.setAttribute("visibility", "hidden");
      cursorDot.setAttribute("visibility", "hidden");
    };

    // Resolve the pointer against the settled window, place the marks, and report. Every change to the cursor and every report comes through here, and the
    // consumer's callback is always the last thing it does, after the state and the marks are final, so a callback that throws leaves the strip consistent.
    const resolve = ({ repaint }) => {

      // Nothing to point at: no pointer, a strip that is off the page, or an empty window. A sample the consumer is still showing is withdrawn once.
      if((scrub.pointerX === null) || !element.isConnected || (currentPoints.length === 0)) {

        // A strip off the page has no pointer over it and gets no leave from a browser that removed it, so only then is the position dropped, while an empty
        // window keeps it so a pointer held over the strip resolves as soon as data arrives.
        if(!element.isConnected) {

          scrub.pointerX = null;
        }

        hideCursor();

        if(scrub.reported !== null) {

          scrub.reported = null;
          onScrub(null);
        }

        return;
      }

      // A slide in flight has the data part-way through a translation the cursor does not follow, so the marks step aside and the last report holds until the
      // settle resolves the pointer against the window it lands.
      if(pendingSlide) {

        hideCursor();

        return;
      }

      const count = currentPoints.length;
      const step = stepFor(count);

      // The nearest sample, clamped so a pointer beyond the plot's left or right edge reads the sample at that edge. Nothing interpolates: the consumer is only ever
      // handed a value some sample actually carries.
      const index = (count > 1) ? Math.min(Math.max(Math.round((scrub.pointerX - LEFT_INSET) / step), 0), count - 1) : 0;
      const value = currentPoints[index];
      const x = coordinate(sampleX({ count, index, step }));

      cursorLine.setAttribute("x1", x);
      cursorLine.setAttribute("x2", x);
      cursorLine.setAttribute("visibility", "visible");
      cursorDot.setAttribute("cx", x);
      cursorDot.setAttribute("cy", coordinate(yFor({ domain: domainFor({ anchor: domainAnchor, points: currentPoints }), value })));
      cursorDot.setAttribute("visibility", "visible");

      // A move reports only when it reaches a different sample. A repaint always reports, because a slid window can put a different sample at the same index with
      // the same value, and the consumer's readout may carry more than the value.
      if(!repaint && (scrub.reported?.index === index)) {

        return;
      }

      scrub.reported = { index, value };
      onScrub(scrub.reported);
    };

    // Map a pointer onto the viewBox through the element's border box, read at the event because the consumer's layout can move or resize the strip at any time. A
    // box with no width has no mapping, so it reads as no pointer at all.
    const track = (event) => {

      const rect = element.getBoundingClientRect();

      scrub.pointerX = (rect.width > 0) ? (((event.clientX - rect.left) / rect.width) * VIEW_WIDTH) : null;
      resolve({ repaint: false });
    };

    const release = () => {

      scrub.pointerX = null;
      resolve({ repaint: false });
    };

    // A press resolves like a move, so a touch reads a sample the moment it lands rather than on its first motion.
    element.addEventListener("pointerdown", track);
    element.addEventListener("pointermove", track);
    element.addEventListener("pointercancel", release);
    element.addEventListener("pointerleave", release);

    return resolve;
  };

  // The scrub is wired only for a consumer that passed a callback, because a cursor with no readout is a mark with no meaning: a strip built without one carries no
  // cursor, no listener and no touch rule, and every repaint skips the resolve.
  const resolveScrub = (typeof onScrub === "function") ? wireScrub() : null;

  // Land the slide: drop the inline transition and transform the animation ran on, then draw the settled window at its own spacing and resolve any held pointer.
  const settleSlide = ({ points, step }) => {

    if(!clearPendingSlide()) {

      return;
    }

    slideGroup.style.transition = "";
    slideGroup.style.transform = "";
    paint({ points, step });
    resolveScrub?.({ repaint: true });
  };

  /**
   * Repaint the strip with a new window.
   *
   * @param {SparklineUpdateOptions} options - The window to draw and how to get there.
   * @returns {void}
   */
  const update = ({ ariaLabel = undefined, points, slide = false }) => {

    const nextPoints = normalizePoints(points);
    const previousPoints = currentPoints;
    const step = stepFor(nextPoints.length);

    applyAriaLabel(ariaLabel);

    currentPoints = nextPoints;

    // A newer window supersedes anything still animating. Cancelling first means the in-flight slide's settle can never land on top of this update, and it is why
    // an update arriving mid-slide always applies instantly: arming a second transition on a group already part-way through a transform reads as a jump, not as
    // motion carrying the data forward.
    const wasSliding = clearPendingSlide();

    if(wasSliding) {

      slideGroup.style.transition = "";
      slideGroup.style.transform = "";
    }

    if(!slide || wasSliding || !isOneStepShift({ next: nextPoints, previous: previousPoints }) || prefersReducedMotion()) {

      paint({ points: nextPoints, step });
      resolveScrub?.({ repaint: true });

      return;
    }

    // The conveyor. The outgoing sample and the whole new window are drawn together on one shared scale, at the settled window's own spacing, so the visible points
    // start exactly where they already were and the newest one waits one step beyond the right edge. Translating the group left by that one step then carries the
    // new sample in as the oldest one leaves.
    const union = [ previousPoints[0], ...nextPoints ];

    slideGroup.style.transition = "";
    slideGroup.style.transform = "translateX(0px)";
    paint({ points: union, step });

    // Read back a geometric property to force the parked position through style resolution. Without the flush the browser coalesces the park and the destination
    // into one frame, and the group arrives with no animation at all.
    void slideGroup.getBoundingClientRect();

    const listener = (event) => {

      // Only this group's own transform transition ends the slide. A child's transition bubbles up to the same listener, and settling on it would cut the motion
      // short part-way through.
      if((event.target !== slideGroup) || (event.propertyName !== "transform")) {

        return;
      }

      settleSlide({ points: nextPoints, step });
    };

    slideGroup.addEventListener("transitionend", listener, { once: false });

    // The fallback bounds the settle for the cases where the completion event never arrives. Bare setTimeout and clearTimeout, never window-qualified, so a test's
    // mock timers intercept them the same way they intercept every other timer in this codebase.
    pendingSlide = { listener, timer: setTimeout(() => settleSlide({ points: nextPoints, step }), SLIDE_DURATION_MS + SETTLE_FALLBACK_MARGIN_MS) };

    slideGroup.style.transition = "transform " + String(SLIDE_DURATION_MS) + "ms " + SLIDE_EASING;
    slideGroup.style.transform = "translateX(-" + coordinate(step) + "px)";

    // The slide is armed, so a held pointer resolves against it: the cursor steps aside while the data moves and returns when the settle lands the window.
    resolveScrub?.({ repaint: true });
  };

  applyAriaLabel(ariaLabel);
  paint({ points: currentPoints, step: stepFor(currentPoints.length) });

  return { element, update };
}

/**
 * Read the direction a window of numbers is moving in.
 *
 * A pure function, deliberately separate from the strip: the direction a consumer renders beside its value is the same reading whether or not a sparkline is on the
 * page, and a consumer that wants only the arrow should not have to build an element to get it. The reading is first-to-last across the whole window rather than a
 * fit through it, which is what a glance at the strip itself reports.
 *
 * @param {TrendDirectionOptions} options - The window and the deadband to read it with.
 * @returns {TrendDirection} The direction, with `"steady"` covering both a window too short to have one and a change inside the deadband.
 */
export function trendDirection({ deadband = 0, points }) {

  const values = normalizePoints(points);

  // Fewer than two samples have no direction to report. The guard is explicit because the alternative reads a difference against a sample that is not there and
  // reports a confident direction from NaN.
  if(values.length < 2) {

    return "steady";
  }

  const delta = values[values.length - 1] - values[0];
  const threshold = (Number.isFinite(deadband) && (deadband > 0)) ? deadband : 0;

  // At or inside the deadband is no movement worth reporting, which also makes a deadband of zero behave the way a caller expects: an exactly flat window is
  // steady, and anything else has a direction.
  if(Math.abs(delta) <= threshold) {

    return "steady";
  }

  return (delta > 0) ? "rising" : "falling";
}
