#!/bin/bash
cd /Users/orca/ai/otter-buddy/.claude/worktrees/fix-signature-url

# Fix feature ID format issues (must be F + 8 digits + exactly 4 alphanumeric)
# Too short (3 chars) - pad with trailing digit
sed -i '' 's/^id: F20260721cap$/id: F20260721cap0/' docs/features/2026/07/21/F20260721cap-capability-oriented-skills.md
sed -i '' 's/^id: F20260722ctx$/id: F20260722ctx0/' docs/features/2026/07/22/F20260722ctx-context-engine-identity.md
sed -i '' 's/^id: F20260722hq1$/id: F20260722hq10/' docs/features/2026/07/22/F20260722hq1-history-query-skill.md
sed -i '' 's/^id: F20260724dsp$/id: F20260724dsp0/' docs/features/2026/07/24/F20260724dsp-default-dispatch-target.md
sed -i '' 's/^id: F20260731mmr$/id: F20260731mmr0/' docs/features/2026/07/31/F20260731mmr-*.md

# Too long (5-6 chars) - truncate to 4
sed -i '' 's/^id: F20260721speak$/id: F20260721spea/' docs/features/2026/07/21/F20260721speak-speak-skill.md
sed -i '' 's/^id: F20260722tools$/id: F20260722tool/' docs/features/2026/07/22/F20260722tools-agent-tools-audit-fix.md
sed -i '' 's/^id: F20260727guard$/id: F20260727guar/' docs/features/2026/07/27/F20260727guard-degenerate-output-guard.md
sed -i '' 's/^id: F20260803chunk$/id: F20260803chun/' docs/features/2026/08/03/F20260803chunk-document-chunking.md
sed -i '' 's/^id: F20260805hybrid$/id: F20260805hybr/' docs/features/2026/08/05/F20260805hybrid-search-fusion.md
sed -i '' 's/^id: F20260807aropt$/id: F20260807arop/' docs/features/2026/08/07/F20260807aropt-adversarial-review-optimize.md
sed -i '' 's/^id: F20260807factlim$/id: F20260807fact/' docs/features/2026/08/07/F20260807factlim-fact-content-length-limit.md
sed -i '' 's/^id: F20260810rstart$/id: F20260810rsta/' docs/features/2026/08/10/F20260810rstart-agent-restart-otter-tool.md
sed -i '' 's/^id: F20260810tools$/id: F20260810tool/' docs/features/2026/08/10/F20260810tools-small-otter-coding-tools.md

echo "Done fixing IDs"
