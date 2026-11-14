// Talk to ego in the terminal. Switch who you are with `/as <id> <name>` to play several people of the network;
// `/network` prints the network document, `/memory [id]` what ego remembers about a person. Where state is kept: EGO_STORAGE (`storage.ts`), state/ego.db by default.
//
//   ANTHROPIC_API_KEY=... npm run chat
//   EGO_STORAGE=cockroach COCKROACH_URL=postgresql://root@localhost:26257/defaultdb?sslmode=disable npm run chat
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { openEgo } from "./agent.ts";
import { anthropic } from "./models.ts";
import { openStorage, storageSettings } from "./storage.ts";

mkdirSync("state", { recursive: true });

const { models, model } = anthropic();
const settings = storageSettings();
const storage = await openStorage({
    ...settings,
    // Another process took the storage over: this one must not go on.
    onLost: (error) => {
        console.error(error.message);
        process.exit(1);
    },
});
// The summaries of the consolidation task run on a cheaper model.
const memoryModel = { provider: model.provider, modelId: process.env.EGO_MEMORY_MODEL ?? "claude-haiku-5-5" };
const ego = await openEgo({ storage, models, model, memoryModel });
const rl = createInterface({ input: process.stdin, output: process.stdout });

let me: { id: string; name: string; email?: string } = { id: "me", name: "Me" };

console.log(`ego on ${model.modelId}, ${settings.kind} storage. /as <id> <name> [email] to switch person, /network, /memory [id] and /outbox to inspect, /quit to leave.`);

const prompt = () => {
    rl.setPrompt(`${me.name}> `);
    rl.prompt();
};

prompt();

for await (const raw of rl) {
    const line = raw.trim();

    if (line === "/quit") break;

    if (line.startsWith("/as ")) {
        const [, id, ...rest] = line.split(/\s+/);
        const email = rest.at(-1)?.includes("@") ? rest.pop() : undefined;

        if (id !== undefined) me = { id, name: rest.join(" ") || id, ...(email === undefined ? {} : { email }) };
    } else if (line.startsWith("/memory")) {
        const id = line.split(/\s+/)[1] ?? me.id;
        console.log(JSON.stringify(await ego.memory(id), null, 2));
    } else if (line === "/outbox") {
        for (const message of await ego.outbox()) {
            console.log(`${message.message.id} to ${message.message.to}: ${message.status} after ${message.attempts} tries${message.lastError ? ` (${message.lastError})` : ""}`);
        }
    } else if (line === "/network") {
        console.log(JSON.stringify((await ego.network()) ?? "nobody yet", null, 2));
    } else if (line !== "") {
        console.log(`ego: ${await ego.say(me.id, me.name, line, me.email === undefined ? {} : { email: me.email })}\n`);
    }

    prompt();
}

rl.close();
await ego.close();
