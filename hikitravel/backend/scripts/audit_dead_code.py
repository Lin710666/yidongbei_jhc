"""静态扫描：找出"写了但没用"的代码（未使用的导入 / 只定义过一次的名字）。

用法（backend 目录下）：.venv\\Scripts\\python.exe scripts\\audit_dead_code.py

原理：
1. 未使用的导入：AST 解析 import 名，再看该文件里是否还有别处引用；
2. 疑似死代码：统计每个 def/class/常量名在整个 app/ 下出现的次数，
   如果只在自己定义处出现过一次，说明没有任何地方引用它（可能确实是死代码，
   也可能是被文档/反射使用，需要人工确认）。
"""
import ast
import sys
from collections import defaultdict
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent / "app"


def iter_py_files():
    return sorted(p for p in ROOT.rglob("*.py"))


def unused_imports(path: Path, tree: ast.AST) -> list:
    """返回该文件里"导入了但没被用到"的名字。"""
    imported = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imported[(alias.asname or alias.name.split(".")[0])] = node.lineno
        elif isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name == "*":
                    continue
                imported[(alias.asname or alias.name)] = node.lineno

    used = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            used.add(node.id)
        elif isinstance(node, ast.Attribute):
            pass
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            # 字符串注解（如 -> "TravelPlan"）也算用到
            used.add(node.value.split(".")[0])
    # 属性访问的根名字（如 httpx.get 里的 httpx）
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute):
            base = node
            while isinstance(base, ast.Attribute):
                base = base.value
            if isinstance(base, ast.Name):
                used.add(base.id)

    return [
        (name, lineno)
        for name, lineno in sorted(imported.items(), key=lambda kv: kv[1])
        if name not in used
    ]


def main() -> int:
    files = iter_py_files()
    sources = {p: p.read_text(encoding="utf-8") for p in files}
    trees = {p: ast.parse(src) for p, src in sources.items()}

    print("=" * 20, "1) 未使用的导入", "=" * 20)
    for path, tree in trees.items():
        for name, lineno in unused_imports(path, tree):
            print(f"{path.relative_to(ROOT.parent)}:{lineno}  未使用: {name}")

    print("=" * 20, "2) 只定义过、没人引用的名字", "=" * 20)
    definitions = defaultdict(list)
    for path, tree in trees.items():
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                definitions[node.name].append((path, node.lineno, "def/class"))
            elif isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id.isupper():
                        definitions[target.id].append((path, node.lineno, "常量"))

    all_source = "\n".join(sources.values())
    for name, places in sorted(definitions.items()):
        # 名字在全部源码里出现的次数（含定义处）
        occurrences = all_source.count(name)
        if occurrences <= len(places):
            for path, lineno, kind in places:
                print(f"{path.relative_to(ROOT.parent)}:{lineno}  {kind} 只出现过 {occurrences} 次: {name}")

    print("=" * 20, "3) 模型字段使用情况（后端）", "=" * 20)
    from app.models.plan import TravelPlan
    from app.models.preference import UserPreference

    frontend = (ROOT.parent.parent / "frontend" / "src").read_text
    frontend_sources = "\n".join(
        p.read_text(encoding="utf-8")
        for p in (ROOT.parent.parent / "frontend" / "src").rglob("*.ts*")
    )
    for model, label in ((UserPreference, "UserPreference"), (TravelPlan, "TravelPlan")):
        for field in model.model_fields:
            in_backend = all_source.count(field)
            in_frontend = frontend_sources.count(field)
            if in_backend <= 1 and in_frontend == 0:
                print(f"{label}.{field}: 后端 {in_backend} 次 / 前端 {in_frontend} 次 ← 疑似无用")

    print("=" * 20, "4) 前端导出的名字 / 类型字段", "=" * 20)
    import re

    ts_files = list((ROOT.parent.parent / "frontend" / "src").rglob("*.ts*"))
    ts_sources = {p: p.read_text(encoding="utf-8") for p in ts_files}
    frontend_all = "\n".join(ts_sources.values())

    for path, src in ts_sources.items():
        for match in re.finditer(
            r"export\s+(?:interface|type|const|function|class)\s+([A-Za-z_]\w*)", src
        ):
            name = match.group(1)
            if frontend_all.count(name) <= 1:
                print(f"{path.relative_to(ROOT.parent.parent)}  导出但前端内没人用: {name}")

    # 类型字段：接口里声明了、但全前端只出现一次（就是声明处）
    for path in [p for p in ts_files if "types" in str(p)]:
        src = ts_sources[path]
        for match in re.finditer(r"^\s{2}([a-z_]\w*)\??:\s", src, re.MULTILINE):
            field = match.group(1)
            if frontend_all.count(field) <= 1:
                print(f"{path.relative_to(ROOT.parent.parent)}  字段无人使用: {field}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
