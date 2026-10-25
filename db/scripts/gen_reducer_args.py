"""Regenerate src/reducer_args.ts from src/index.ts. Run from db/: python3 scripts/gen_reducer_args.py"""
import re
idx = open('src/index.ts').read()
out = ["// GENERATED from src/index.ts by scripts/gen_reducer_args.py — do not edit.",
       "// Reducer name → parameter names in CONTRACT order (request_id first). Names ending _cents/_milli are i64.",
       "export const REDUCER_ARGS: Record<string, string[]> = {"]
for m in re.finditer(r"export const (\w+) = spacetimedb\.reducer\(\s*\{([^}]*)\}", idx, re.S):
    names = [x.split(':')[0].strip() for x in m.group(2).split(',') if x.strip()]
    out.append(f"  {m.group(1)}: {names!r},".replace("'", '"'))
out.append("};")
open('src/reducer_args.ts', 'w').write("\n".join(out) + "\n")
