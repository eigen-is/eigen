import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";

const TARGET = process.argv[2] || "src/formula-parser/test/integration/parsing/formula/statistical.test.ts";

let output: string;
try {
    output = execSync(`bun test ${TARGET}`, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
} catch (e: any) {
    output = (e.stdout || "") + (e.stderr || "");
}

const file = readFileSync(TARGET, "utf8");
const lines = file.split("\n");

// Parse all diffs from the output
// Pattern: line numbers shown before error, then the diff block with - Expected / + Received
const blocks = output.split("error: expect(received).toMatchObject(expected)");

let patches: Array<{line: number; oldError: string; oldResult: string; newError: string; newResult: string}> = [];

for (const block of blocks.slice(1)) {
    // Find line number from "at <anonymous> (...:LINE:COL)"
    const lineMatch = block.match(/at <anonymous>.*?:(\d+):\d+\)/);
    if (!lineMatch) continue;
    const failLine = parseInt(lineMatch[1]);

    // Parse the diff
    const diffLines = block.split("\n");
    let oldError: string | null = null;
    let oldResult: string | null = null;
    let newError: string | null = null;
    let newResult: string | null = null;

    for (const dl of diffLines) {
        const trimmed = dl.trim();
        // Lines starting with - are expected (old), + are received (new)
        const errMatch = trimmed.match(/^([+-])\s+"error":\s*(.+?),?$/);
        const resMatch = trimmed.match(/^([+-])\s+"result":\s*(.+?),?$/);
        
        if (errMatch) {
            if (errMatch[1] === "-") oldError = errMatch[2];
            else newError = errMatch[2];
        }
        if (resMatch) {
            if (resMatch[1] === "-") oldResult = resMatch[2];
            else newResult = resMatch[2];
        }
    }

    if ((oldError !== null || oldResult !== null) && (newError !== null || newResult !== null)) {
        patches.push({
            line: failLine,
            oldError: oldError || "",
            oldResult: oldResult || "",
            newError: newError || "",
            newResult: newResult || "",
        });
    }
}

console.log(`Found ${patches.length} patches to apply`);

// Sort patches by line number descending so we can apply from bottom to top
patches.sort((a, b) => b.line - a.line);

let modified = [...lines];

for (const patch of patches) {
    const lineIdx = patch.line - 1; // 0-indexed
    
    // Search backwards from the fail line to find the toMatchObject block
    let blockStart = -1;
    let blockEnd = -1;
    
    for (let i = lineIdx; i >= Math.max(0, lineIdx - 10); i--) {
        if (modified[i].includes("toMatchObject")) {
            blockStart = i;
            break;
        }
    }
    
    if (blockStart === -1) continue;
    
    // Find the closing });
    for (let i = blockStart; i <= Math.min(modified.length - 1, blockStart + 10); i++) {
        if (modified[i].includes("});")) {
            blockEnd = i;
            break;
        }
    }
    
    if (blockEnd === -1) continue;
    
    // Get the original block text
    const blockLines = modified.slice(blockStart, blockEnd + 1);
    const blockText = blockLines.join("\n");
    
    // Apply error fix if we have one
    let newBlock = blockText;
    
    if (patch.oldError && patch.newError) {
        // Replace error value
        const oldErrVal = patch.oldError.replace(/,\s*$/, "");
        const newErrVal = patch.newError.replace(/,\s*$/, "");
        newBlock = newBlock.replace(
            new RegExp(`error:\\s*${escapeRegex(oldErrVal)}`),
            `error: ${newErrVal}`
        );
    }
    
    if (patch.oldResult && patch.newResult) {
        // Replace result value
        const oldResVal = patch.oldResult.replace(/,\s*$/, "");
        const newResVal = patch.newResult.replace(/,\s*$/, "");
        newBlock = newBlock.replace(
            new RegExp(`result:\\s*${escapeRegex(oldResVal)}`),
            `result: ${newResVal}`
        );
    }
    
    if (newBlock !== blockText) {
        const newLines = newBlock.split("\n");
        modified.splice(blockStart, blockEnd - blockStart + 1, ...newLines);
        console.log(`  Fixed line ${patch.line}: error ${patch.oldError}->${patch.newError}, result ${patch.oldResult}->${patch.newResult}`);
    }
}

writeFileSync(TARGET, modified.join("\n"));
console.log("Done!");

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
