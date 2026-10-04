/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * webui/index.ts: The webUI's TypeScript, the modules that run in the browser beside the page. The package root re-exports this barrel, so it re-exports whole
 * contract modules and never a module that touches the document: importing the package in Node evaluates every module named here, and a module that reaches for
 * the document fails there.
 */
export * from "./status.ts";
