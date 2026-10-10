// Approximate tokens (chars/4) of what a client loads up-front: tools/list + server instructions.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { createServices } from "../dist/services.js";

const server = createServer(createServices());
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
const client = new Client({ name: "measure", version: "0" });
await client.connect(b);
const { tools } = await client.listTools();
const list = JSON.stringify(tools).length;
const instr = (client.getInstructions() ?? "").length;
console.log(`tools/list ${tools.length} tools ≈${Math.round(list / 4)} tok; instructions ≈${Math.round(instr / 4)} tok`);
for (const t of tools) console.log(`  ${t.name}\t≈${Math.round(JSON.stringify(t).length / 4)} tok`);
process.exit(0);
