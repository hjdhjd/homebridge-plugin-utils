/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ui/webUi-svg.mjs: The SVG element builder every graphic in the plugin webUI draws through.
 */

/**
 * How an SVG element comes into being in the webUI, defined once for every graphic it draws - the sparkline strip's marks and the feature-options glyphs alike -
 * rather than per drawing.
 *
 * The module holds no store and no plugin knowledge, and imports nothing, which is what lets the page-level primitives and the feature-options subsystem both build
 * on it from below rather than one reaching into the other.
 *
 * @module
 */
"use strict";

// The namespace every SVG element must be created in. `document.createElement("svg")` yields an inert HTML element that happens to share the tag name and renders
// nothing, so the namespaced constructor is the only way to build a graphic the browser will draw.
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * Create one SVG element with its attributes applied. Graphics are built here rather than through an HTML element builder for two reasons the DOM imposes: SVG
 * elements need the namespaced constructor, and SVG takes its presentation as attributes rather than as the properties an HTML builder assigns.
 *
 * @param {Object} options - The element to build.
 * @param {Object<string, string>} [options.attributes={}] - The attributes to apply.
 * @param {string} options.tag - The SVG tag name.
 * @returns {SVGElement} The created element.
 */
export function createSvgElement({ attributes = {}, tag }) {

  const element = document.createElementNS(SVG_NAMESPACE, tag);

  for(const [ name, value ] of Object.entries(attributes)) {

    element.setAttribute(name, value);
  }

  return element;
}
