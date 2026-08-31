import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root — stable even when modules move under src/. */
export const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SRC_DIR = join(ROOT_DIR, "src");
export const KNOWLEDGE_DIR = join(ROOT_DIR, "knowledge");
export const DATA_DIR = join(ROOT_DIR, "data");
