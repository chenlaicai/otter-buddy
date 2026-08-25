#!/usr/bin/env python3
"""PR #452 hook 回归验证脚本（检视獭-452 建议发现 1：脚本入档备查）。

原理：从 .githooks/commit-msg 精确提取 is_template_valid 的 node 代码段，
逐用例真实执行（非重写正则），验证类型白名单与模块段行为。

用法：python3 scripts/tmp-verify/hook-regression-verify.py
预期：全部 PASS，exit 0；任一 MISMATCH，exit 1。
"""
import re, json, subprocess, sys

src = open('.githooks/commit-msg').read()
m = re.search(r'is_template_valid=\$\(node -e "\n(.*?)\n" "\$first_line"\)', src, re.S)
if not m:
    print('FATAL: 无法从 commit-msg 提取 node 代码段（结构已变？）'); sys.exit(2)
script = m.group(1).replace('\\\\', '\\')
script = script.replace('const title = process.argv[1];', 'const title = T;')
script = script.replace("process.stdout.write((f.test(title) || r.test(title)) ? 'yes' : 'no');",
                        "RESULTS.push((f.test(title) || r.test(title)) ? 'yes' : 'no');")

# 注意：ID 后缀须用合法字符集（首位 a-kmnp-z，后 3-9 位 2-9a-kmnp-z，排除 l/o/0/1）
cases = [
    ('[F20260825zzzz][ci][Design] 提交规范三方一致性订正：文档收敛类型清单至 5 种', True),
    ('[F20260825zzza][ci][New Feature] 新功能应通过', True),
    ('[R20260825zzzb][ci] research 无类型应通过', True),
    ('[F20260825zzzc][ci][Feature] 类型 Feature 应拒绝', False),
    ('[F20260825zzzd][ci-x][Design] 模块段连字符应拒绝', False),
    ('[F20260825cmhg][ci][BugFix] 存量ID应通过', True),
]
body = ("const CASES = " + json.dumps([c[0] for c in cases], ensure_ascii=False)
        + ";\nconst RESULTS=[];\nfor (const T of CASES) {\n" + script
        + "\n}\nconsole.log(RESULTS.join(','));")
r = subprocess.run(['node', '-e', body], capture_output=True, text=True)
if r.returncode != 0:
    print('FATAL node error:', r.stderr[:500]); sys.exit(2)
results = r.stdout.strip().split(',')
ok = True
for (case, expected), got in zip(cases, results):
    good = (got == 'yes') == expected
    ok &= good
    print(f"{'PASS' if good else 'MISMATCH'}: expect {'yes' if expected else 'no'}, got {got} | {case}")
print('ALL OK' if ok else 'HAS MISMATCH')
sys.exit(0 if ok else 1)
