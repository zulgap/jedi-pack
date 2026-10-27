# _test_check_parts.py — 부품 위키 확인기를 잠근다 (2026-10-27) · python _test_check_parts.py → 끝 줄 ✅ · 실제 부품 없이 돈다
import os, sys; os.environ['PYTHONUTF8'] = '1'; sys.stdout.reconfigure(encoding='utf-8')
import tempfile
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import check_parts as C
fail = 0
def ok(c, m):
    global fail; print(('✅ ' if c else '❌ ') + m); fail += 0 if c else 1

def tree(files):
    root = tempfile.mkdtemp()
    for rel, body in files.items():
        p = os.path.join(root, *rel.split('/')); os.makedirs(os.path.dirname(p), exist_ok=True); open(p, 'w', encoding='utf-8').write(body)
    return root

# A. 판 조건
ok(C.version_ok('4.13.0.92', '<5') and not C.version_ok('5.0.0.93', '<5'), 'A1 OpenCV 4 통과 · 5 막힘 (10/26 경훈 PC)')
ok(not C.version_ok('19.0.2', '<19') and C.version_ok('18.0.0', '<19'), 'A2 PyAV 19 막힘 · 18 통과')
ok(C.version_ok('13.0.0', '<14') and C.version_ok('12.1.1', '>=12,<14') and not C.version_ok('11.0', '>=12,<14'), 'A3 여러 조건')

# B. 코드에서 부품 읽기 — 표준·같은 폴더 도구·팩 공용 모듈은 뺀다 · 함수 안 import 도 센다
r = tree({'plugins/p/skills/s/scripts/a.py': 'import os, json\nimport cv2\nfrom PIL import Image\nimport b\ndef f():\n    from faster_whisper import WhisperModel\n',
          'plugins/p/skills/s/scripts/b.py': 'import nas_path\n', 'plugins/p/shared/nas-path/x.js': ''})
use = C.scan_imports(os.path.join(r, 'plugins/p/skills/s/scripts'))
ok(set(use) == {'cv2', 'PIL', 'faster_whisper'}, f'B1 바깥 부품만 · 함수 안 import 포함 ({sorted(use)})')
ok(C.needed(use)[:0] == [] and {'ctranslate2', 'av'} <= set(C.needed(use)), 'B2 받아쓰기는 끌려오는 부품(엔진·PyAV)까지 본다')
ok(C.needed({'win32gui': 1, 'win32com': 1}) == ['win32com'], 'B3 같은 부품의 다른 이름은 하나로')

# C. 🔴 위키에 없는 부품을 쓰면 감사가 막는다 (새 도구가 새 부품을 쓰기 시작한 날)
r2 = tree({'plugins/p/skills/s/scripts/a.py': 'import pandas\nimport cv2\n'})
lines = []; orig = print
import builtins; builtins.print = lambda *a, **k: lines.append(' '.join(map(str, a)))
n = C.audit(r2); builtins.print = orig
ok(n == 1 and any('pandas' in l and 'parts.json' in l for l in lines), 'C1 위키에 없는 부품 = 실패 + 어디에 한 장 더할지')
ok(C.audit(tree({'plugins/p/skills/s/scripts/a.py': 'import cv2\n'})) == 0, 'C2 위키에 있는 부품만 쓰면 통과')
ok(all(('<' in e['pip'] or '==' in e['pip']) and e['check'] in C.CHECKS for e in C.WIKI.values() if 'same' not in e), 'C3 위키 모든 장에 판 상한 + 확인법')

# D. 확인 결과 — 판이 넘으면 ❌ + 깔 것 · 확인이 깨지면 ❌ + 이유 · 다 되면 ✅
r3 = tree({'plugins/p/skills/s/scripts/a.py': 'import cv2\n'}); sk = os.path.join(r3, 'plugins/p/skills/s')
real_v, real_chk = C.installed_version, C.CHECKS['cv2']
C.installed_version = lambda e: ('opencv-python', '5.0.0.93'); out = []
ok(C.check_skill(sk, out.append) == 1 and any('5.0.0.93' in l and 'opencv-python<5' in l for l in out), 'D1 5판 깔림 = ❌ + 「opencv-python<5」')
C.installed_version = lambda e: ('opencv-python', '4.13.0'); C.CHECKS['cv2'] = lambda k: (_ for _ in ()).throw(RuntimeError('얼굴 찾기가 없습니다')); out = []
ok(C.check_skill(sk, out.append) == 1 and any('얼굴 찾기가 없습니다' in l for l in out), 'D2 판은 맞는데 확인이 깨짐 = ❌ + 이유')
C.CHECKS['cv2'] = lambda k: None; out = []
ok(C.check_skill(sk, out.append) == 0 and out[-1].endswith('통과'), 'D3 다 되면 ✅')
C.installed_version = lambda e: (None, None); out = []
ok(C.check_skill(sk, out.append) == 1 and any('안 깔려' in l for l in out), 'D4 🔴 안 깔림 = 건너뛰지 않고 ❌')
C.installed_version, C.CHECKS['cv2'] = real_v, real_chk

# E. 사람용 보기에 겪은 일까지 나온다
w = C.wiki(r)
ok('얼굴 찾기(OpenCV)' in w and '10/26 경훈 PC' in w and 'opencv-python<5' in w, 'E1 위키 보기 = 깔기·확인법·쓰는 스킬·겪은 일')

print(f'\n{"❌ 실패 " + str(fail) if fail else "✅ 전부 통과"}'); sys.exit(1 if fail else 0)
