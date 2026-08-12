#!/usr/bin/env node
import readline from "node:readline";
import { generateReply, restaurant } from "./reply.js";

console.log(` ${restaurant.name} — local FAQ demo`);
console.log(" Type /quit to exit\n");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function prompt() {
  rl.question("Guest > ", (line) => {
    const msg = line.trim();
    if (!msg) return prompt();
    if (msg === "/quit" || msg === "/exit") {
      rl.close();
      return;
    }
    console.log("\nBot  >\n" + generateReply(msg) + "\n");
    prompt();
  });
}

prompt();
