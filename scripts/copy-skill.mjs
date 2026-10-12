import { copyFile, mkdir } from "node:fs/promises";
await mkdir("dist/cheqi", { recursive: true });
await copyFile("skill/cheqi/SKILL.md", "dist/cheqi/SKILL.md");
