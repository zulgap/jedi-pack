# check_parts.py — 부품 위키(parts.json)로 «이 PC 에서 도구 부품이 실제로 도나»를 본다 (2026-10-27)
#   python check_parts.py <스킬 폴더>        → 그 스킬 scripts/ 가 쓰는 부품마다 판 상한 + 짧은 실제 확인 · 끝 줄 ✅/❌ · 하나라도 ❌ 면 끝 코드 1
#   python check_parts.py --audit <팀팩 뿌리> → 팀팩 도구가 쓰는 바깥 부품이 전부 위키에 있나(CI) · 없으면 끝 코드 1
#   python check_parts.py --wiki  <팀팩 뿌리> → 사람용 보기 docs/parts-wiki.md 를 다시 만든다 (--wiki-check = 최신인지만, CI)
# @AI:INTENT 10/26 경훈 PC 셋업이 «준비됨»인데 세 곳이 멈췄다(Pillow 13 · 그래픽카드 float16 · PyAV 19 · OpenCV 5).
#   부품 판을 셋업 계획에 사람이 손으로 적었고, 자체 시험은 계산만 봤다. 이제 도구가 무엇을 쓰는지는 코드(import)에서 읽고,
#   판·확인법은 위키 한 장에만 둔다 — 부품이 바뀌면 그 장만 고친다(서버 도구 위키 docs/mcp-wiki 와 같은 방식, 사장님 10/27)
# @AI:CONSTRAINT 부품이 없거나 판이 넘으면 «건너뛰지 말고» 실패 — 셋업이 «준비됨»이라 말하려면 여기가 다 돌아야 한다
import ast, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
WIKI = json.load(open(os.path.join(HERE, 'parts.json'), encoding='utf-8'))['parts']
SKIP_DIRS = {'node_modules', '.venv', 'venv', '__pycache__', '_template'}


def entry(key):
    e = WIKI.get(key)
    return WIKI.get(e['same']) if e and 'same' in e else e


def scan_imports(scripts_dir):
    """scripts/ 의 .py 가 쓰는 바깥 모듈 이름 → 쓰는 파일 목록 (표준 라이브러리 · 같은 폴더 도구 · 팩 공용 모듈은 뺀다)"""
    std = set(sys.stdlib_module_names)
    files = sorted(f for f in os.listdir(scripts_dir) if f.endswith('.py')) if os.path.isdir(scripts_dir) else []
    local = {f[:-3] for f in files}
    pack_shared = os.path.join(scripts_dir, '..', '..', '..', 'shared')
    if os.path.isdir(pack_shared): local |= {d.replace('-', '_') for d in os.listdir(pack_shared)}
    use = {}
    for f in files:
        try: tree = ast.parse(open(os.path.join(scripts_dir, f), encoding='utf-8').read())
        except Exception: continue
        for n in ast.walk(tree):
            names = [a.name.split('.')[0] for a in n.names] if isinstance(n, ast.Import) else \
                    [n.module.split('.')[0]] if isinstance(n, ast.ImportFrom) and n.module and n.level == 0 else []
            for x in names:
                if x not in std and x not in local: use.setdefault(x, set()).add(f)
    return use


def needed(use):
    """쓰는 모듈 → 확인할 위키 항목(같이 끌려오는 부품 with 포함 · same 은 하나로)"""
    keys, seen = [], set()
    def add(k):
        e = WIKI.get(k); k = e['same'] if e and 'same' in e else k
        if k in seen: return
        seen.add(k); keys.append(k)
        for w in (entry(k) or {}).get('with', []): add(w)
    for m in sorted(use): add(m)
    return keys


def version_ok(ver, cond):
    num = lambda v: [int(x) for x in str(v).split('.') if x.isdigit()]
    def cmp(a, b):
        A, B = num(a), num(b)
        for i in range(max(len(A), len(B))):
            d = (A[i] if i < len(A) else 0) - (B[i] if i < len(B) else 0)
            if d: return -1 if d < 0 else 1
        return 0
    for c in [x.strip() for x in cond.split(',') if x.strip()]:
        for op in ('<=', '>=', '==', '!=', '<', '>'):
            if c.startswith(op):
                d = cmp(ver, c[len(op):]); ok = {'<': d < 0, '<=': d <= 0, '>': d > 0, '>=': d >= 0, '==': d == 0, '!=': d != 0}[op]
                if not ok: return False
                break
    return True


def installed_version(e):
    import importlib.metadata as md
    for d in e.get('dist', []):
        try: return d, md.version(d)
        except md.PackageNotFoundError: pass
    return None, None


# ── 실제 확인 — 짧은 가짜 입력으로 한 번씩 돌린다. 실패하면 사람이 할 일을 문장으로 던진다 ──
def _tmp_wav():
    import tempfile, wave, struct, math
    p = os.path.join(tempfile.mkdtemp(), '1초.wav')   # 한글 경로 — 실제 편 폴더도 한글이다
    w = wave.open(p, 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
    w.writeframes(b''.join(struct.pack('<h', int(8000 * math.sin(i / 8))) for i in range(16000))); w.close()
    return p

def c_import(key): __import__(key)
def c_pil(_):
    from PIL import Image, ImageDraw, ImageFont
    im = Image.new('RGB', (60, 24)); ImageDraw.Draw(im).text((2, 2), 'Ab1', font=ImageFont.load_default(), fill='white')
    if im.getbbox() is None: raise RuntimeError('글자가 그려지지 않았습니다')
def c_numpy(_):
    import numpy as np
    if int((np.arange(4) * 2).sum()) != 12: raise RuntimeError('계산이 틀립니다')
def c_cv2(_):
    import cv2, numpy as np
    if not hasattr(cv2, 'CascadeClassifier'): raise RuntimeError(f'OpenCV {cv2.__version__} 에 얼굴 찾기(CascadeClassifier)가 없습니다')
    for xml in ('haarcascade_frontalface_default.xml', 'haarcascade_eye.xml'):
        d = cv2.CascadeClassifier(cv2.data.haarcascades + xml)
        if d.empty(): raise RuntimeError(f'{xml} 를 못 읽었습니다')
        d.detectMultiScale(np.zeros((120, 120), np.uint8))
def c_av(_):
    from faster_whisper import decode_audio   # 받아쓰기 부품이 파일을 여는 바로 그 길(10/26 19판에서 멈춘 자리)
    if len(decode_audio(_tmp_wav())) < 8000: raise RuntimeError('소리를 못 읽었습니다')
def c_gpu(_):
    import ctranslate2
    ctranslate2.get_cuda_device_count()
def c_whisper(_):
    """작은 모델(tiny)로 1초 받아쓰기 · 그래픽카드가 보이면 그래픽카드로 돌아야 통과(카드가 되는 방식 중 빠른 것)"""
    import numpy as np, ctranslate2
    from faster_whisper import WhisperModel
    sys.path.insert(0, HERE); import cuda_dlls; cuda_dlls.add()
    x = np.zeros(16000, np.float32)
    if ctranslate2.get_cuda_device_count() > 0:
        sup = ctranslate2.get_supported_compute_types('cuda')
        ct = next((c for c in ('float16', 'int8_float16', 'int8') if c in sup), None)
        if not ct: raise RuntimeError('그래픽카드가 쓸 수 있는 계산 방식이 없습니다')
        try:
            segs, _ = WhisperModel('tiny', device='cuda', compute_type=ct).transcribe(x, language='ko', vad_filter=False); list(segs)
        except Exception as e:
            m = str(e).splitlines()[0] if str(e) else type(e).__name__
            hint = ' → pip install nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"' if ('cublas' in m.lower() or 'cudnn' in m.lower()) else ''
            raise RuntimeError(f'그래픽카드 받아쓰기가 안 됩니다 ({ct}) — {m[:120]}{hint}')
        return f'그래픽카드 · {ct}'
    segs, _ = WhisperModel('tiny', device='cpu', compute_type='int8').transcribe(x, language='ko', vad_filter=False); list(segs)
    return 'CPU (그래픽카드 없음 — 느리게 돈다)'
def c_imageio_ffmpeg(_):
    import imageio_ffmpeg
    if not os.path.exists(imageio_ffmpeg.get_ffmpeg_exe()): raise RuntimeError('ffmpeg 실행 파일이 없습니다')
def c_fitz(_):
    import fitz
    d = fitz.open(); d.new_page(); d.close()

CHECKS = {'import': c_import, 'pil': c_pil, 'numpy': c_numpy, 'cv2': c_cv2, 'av': c_av, 'gpu': c_gpu, 'whisper': c_whisper,
          'imageio_ffmpeg': c_imageio_ffmpeg, 'fitz': c_fitz}


def check_skill(skill_dir, out=print):
    use = scan_imports(os.path.join(skill_dir, 'scripts'))
    fails = 0
    for k in needed(use):
        e = entry(k)
        if not e: out(f'❌ {k} — 부품 위키에 없습니다(팀팩에 한 장 추가 필요)'); fails += 1; continue
        if e.get('windows') and os.name != 'nt': continue
        fix = f'pip install "{e["pip"]}"'
        dist, ver = installed_version(e)
        if not ver: out(f'❌ {e["name"]} — 안 깔려 있습니다 → {fix}'); fails += 1; continue
        cond = re.match(r'^[A-Za-z0-9._-]+(.*)$', e['pip']).group(1)
        if not version_ok(ver, cond):
            out(f'❌ {e["name"]} — {ver} 깔림 · 이 판은 확인 안 됨 → {fix}'); fails += 1; continue
        try:
            note = CHECKS[e['check']](k)
            out(f'✅ {e["name"]} {ver}' + (f' · {note}' if note else ''))
        except Exception as ex:
            out(f'❌ {e["name"]} {ver} — {str(ex).splitlines()[0][:200] if str(ex) else type(ex).__name__}'); fails += 1
    out(f'\n{"❌ 부품 " + str(fails) + "개 — 위 ❌ 줄의 할 일을 하고 다시" if fails else "✅ 부품 전부 통과"}')
    return fails


def tool_dirs(root):
    for pk in sorted(os.listdir(os.path.join(root, 'plugins'))):
        sk = os.path.join(root, 'plugins', pk, 'skills')
        if not os.path.isdir(sk): continue
        for s in sorted(os.listdir(sk)):
            if s not in SKIP_DIRS and os.path.isdir(os.path.join(sk, s, 'scripts')): yield pk, s, os.path.join(sk, s)


def audit(root):
    bad = []
    for k, e in WIKI.items():
        if 'same' in e: continue
        if '<' not in e.get('pip', '') and '==' not in e.get('pip', ''): bad.append(f'위키 {k}: 판 상한(<) 없음')
        if e.get('check') not in CHECKS: bad.append(f'위키 {k}: 확인법 {e.get("check")} 없음')
    for pk, s, d in tool_dirs(root):
        for m, files in scan_imports(os.path.join(d, 'scripts')).items():
            if m not in WIKI: bad.append(f'{pk}/{s}: 「{m}」 를 쓰는데 부품 위키에 없음 ({", ".join(sorted(files)[:3])}) → plugins/jedi-core/skills/jedi-setup/parts/parts.json 에 한 장 추가')
    for b in bad: print('❌ ' + b)
    print('✅ 팀팩 도구 부품이 전부 위키에 있음' if not bad else f'\n❌ {len(bad)}건')
    return len(bad)


def wiki(root):
    users = {}
    for pk, s, d in tool_dirs(root):
        for k in needed(scan_imports(os.path.join(d, 'scripts'))): users.setdefault(k, []).append(s)
    L = ['# 부품 위키 (자동 생성 — 손으로 고치지 말 것)', '',
         '> 정본 = `plugins/jedi-core/skills/jedi-setup/parts/parts.json` · 생성 = `python plugins/jedi-core/skills/jedi-setup/parts/check_parts.py --wiki .`',
         '> 셋업 마지막 자체 시험이 그 스킬이 쓰는 부품을 이 표대로 실제로 돌려 본다. 부품이 바뀌면 위키 한 장만 고친다.', '']
    for k, e in WIKI.items():
        if 'same' in e: continue
        L += [f'## {e["name"]}', '', f'- 깔기: `pip install "{e["pip"]}"`', f'- 확인법: `{e["check"]}`' + (' (윈도만)' if e.get('windows') else ''),
              f'- 쓰는 스킬: {", ".join(sorted(set(users.get(k, [])))) or "없음"}']
        if e.get('with'): L.append(f'- 같이 끌려오는 부품: {", ".join(entry(w)["name"] for w in e["with"])}')
        if e.get('note'): L.append(f'- 참고: {e["note"]}')
        for i in e.get('incidents', []): L.append(f'- 겪은 일: {i}')
        L.append('')
    return '\n'.join(L)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    a = sys.argv[1:]
    if a[:1] == ['--audit']: sys.exit(1 if audit(a[1] if len(a) > 1 else '.') else 0)
    if a[:1] in (['--wiki'], ['--wiki-check']):
        root = a[1] if len(a) > 1 else '.'; dst = os.path.join(root, 'docs', 'parts-wiki.md'); body = wiki(root) + '\n'
        if a[0] == '--wiki': open(dst, 'w', encoding='utf-8', newline='\n').write(body); print(f'✅ {dst}'); sys.exit(0)
        cur = open(dst, encoding='utf-8').read().replace('\r\n', '\n') if os.path.exists(dst) else ''
        if cur == body: print('✅ 부품 위키 보기(docs/parts-wiki.md)가 최신'); sys.exit(0)
        print('❌ docs/parts-wiki.md 가 parts.json·도구와 다릅니다 → python plugins/jedi-core/skills/jedi-setup/parts/check_parts.py --wiki .'); sys.exit(1)
    if not a: print(__doc__ or 'python check_parts.py <스킬 폴더>'); sys.exit(2)
    sys.exit(1 if check_skill(a[0]) else 0)
