import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDiscordEmoji } from "../src/discord/emoji.ts";

const ID = "123456789012345678";

test("a single unicode emoji passes through, including a ZWJ sequence", () => {
  assert.equal(resolveDiscordEmoji("👍"), "👍");
  assert.equal(resolveDiscordEmoji(" 👨‍👩‍👧 "), "👨‍👩‍👧");
});

test("text that merely starts with an emoji is not an emoji", () => {
  assert.equal(resolveDiscordEmoji("👍 thanks"), null);
  assert.equal(resolveDiscordEmoji("👍👍"), null);
});

test("custom emoji in both spellings resolve to the REST form", () => {
  assert.equal(resolveDiscordEmoji(`<:party:${ID}>`), `party:${ID}`);
  assert.equal(resolveDiscordEmoji(`<a:party:${ID}>`), `a:party:${ID}`);
  assert.equal(resolveDiscordEmoji(`party:${ID}`), `party:${ID}`);
  assert.equal(resolveDiscordEmoji("party:123"), null);
});
