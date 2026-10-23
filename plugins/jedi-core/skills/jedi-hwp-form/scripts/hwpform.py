# -*- coding: utf-8 -*-
"""한글 양식 작업 CLI — 조사 · 변환 · 편집 · 검수. 🔴 한글 작업은 이 도구 하나로 한다.

  조사·변환
    python hwpform.py inspect  <파일.hwpx>                         양식 구조 (칸 주소·글자·빈칸)
    python hwpform.py to-hwpx  <입력.hwp>  <출력.hwpx>              한컴 필요
    python hwpform.py to-hwp   <입력.hwpx> <출력.hwp> [출력.pdf]    한컴 필요
  편집 (입력 .hwp/.hwpx → 출력 .hwp 이면 PDF 를 뽑아 verify 까지 자동)
    python hwpform.py replace     <입력> <출력> --map 바꿀목록.txt|.json  [--set "옛=>새" ...]
    python hwpform.py color-dates <입력> <출력> [--only "2026.10.21|2026.10.22"] [--expect N]
    python hwpform.py margin      <입력> <출력> --top 8 --bottom 5   (mm 명시값)
    python hwpform.py pics        <입력> <출력> --cell 11,0 --cols 2 --images a.jpg b.jpg [--captions ...]
    python hwpform.py stamp       <입력> <출력.hwp> --after "(인)" --image 도장.png [--mm 15]   한컴 필요
    python hwpform.py delete-pics <입력> <출력> --near "(인)" [--name 도장.png] [--expect N]
    python hwpform.py table-split <입력> <출력> --contains "편 구성" --rows 8 [--header 1] [--page-break]
    python hwpform.py fill        <입력> <출력> --cells 칸.json   ({"행,열": "값\\n둘째 줄", …})
      공통: [--pdf 결과.pdf] [--expect-pages N]
  검수
    python hwpform.py verify   <결과.pdf> [--expect-pages N] [--baseline 기존.pdf]
                               [--absent "옛 글자|…"] [--expect-red N]

칸 주소로 값을 통째로 넣는 일은 fill 로 한다. 칸마다 다른 처방(메모 칸·조각 칸)이 필요하면
hwpx_lib 을 불러 쓰는 짧은 스크립트로 하되, 한컴 변환은 이 파일의 convert() 를 부른다.
"""
import argparse
import json
import os
import re
import sys
import subprocess
import tempfile
import time
from xml.sax.saxutils import escape, unescape

sys.stdout.reconfigure(encoding='utf-8', line_buffering=True)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hwpx_lib as H


# ────────────────────────────────────────────────────────────
# 한컴 (변환·PDF 에만 필요 — Windows + 한컴오피스)
#
# 🔴 한컴을 부르는 곳은 이 절 «한 곳뿐»이다. 다른 스크립트·세션 임시 파일에서
#    win32com 으로 한글을 직접 띄우지 말 것 — 10/22 한 세션에서 도구가 일곱 벌로
#    갈라져 보안 모듈 이름·창 처리·종료 방식이 서로 달랐고 멈춤이 5번 넘게 났다.
# ────────────────────────────────────────────────────────────

# @AI:CONSTRAINT 레지스트리 등록 이름 = RegisterModule 두 번째 인자. 둘이 다르면
#   RegisterModule 이 False 를 주고 보안 승인창 대기(파일당 40초)로 되돌아간다.
#   pyhwpx·옛 도구의 기본값 'FilePathCheckerModule' 은 «틀린 이름»이다.
SECURITY_MODULE = 'FilePathCheckerModuleExample'


def _ensure_security_module():
    """한글 자동화 보안 팝업을 없앤다. 등록된 모듈 이름을 돌려준다.

    🔴 이걸 안 하면 파일 하나 여는 데 **42.5초**가 걸린다(실측). 보안 승인창이
    떠서 기다리는 시간이고, 등록 후에는 **0.1초**다.

    한컴 설치본에 검사 모듈 DLL 은 이미 들어 있는데 레지스트리에 등록돼 있지
    않은 경우가 많다. 등록은 HKCU 라 **관리자 권한이 필요 없다**.
    되돌리려면 그 값을 지우면 된다:
      HKCU\\Software\\HNC\\HwpAutomation\\Modules
    """
    import winreg
    KEY = r'Software\HNC\HwpAutomation\Modules'
    NAME = SECURITY_MODULE

    # 이미 등록돼 있으면 그대로 쓴다
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, KEY) as k:
            path, _ = winreg.QueryValueEx(k, NAME)
            if os.path.exists(path):
                return NAME
    except OSError:
        pass

    # DLL 을 찾는다 (설치 위치가 PC마다 다르므로 후보를 훑는다)
    cands = []
    for root in (os.environ.get('ProgramFiles(x86)', r'C:\Program Files (x86)'),
                 os.environ.get('ProgramFiles', r'C:\Program Files')):
        cands.append(os.path.join(root, 'Hnc', 'ExCtrl', 'Bin', NAME + '.dll'))
    dll = next((c for c in cands if os.path.exists(c)), None)
    if not dll:
        print('  (참고) 보안 검사 모듈 DLL 을 못 찾았습니다. 파일 여는 데 시간이 걸리고\n'
              '         한글 보안 창이 뜰 수 있습니다. 뜨면 «허용»을 눌러주세요.')
        return None

    try:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, KEY) as k:
            winreg.SetValueEx(k, NAME, 0, winreg.REG_SZ, dll)
        print('  보안 모듈을 등록했습니다 (한 번만 하면 됩니다). 이제 팝업 없이 열립니다.')
        return NAME
    except Exception as e:
        print('  (참고) 보안 모듈 등록 실패 — 팝업이 뜰 수 있습니다: %s' % e)
        return None


def _hwp_pids():
    """지금 떠 있는 한글(Hwp.exe) 프로세스 번호들."""
    try:
        out = subprocess.run('tasklist /FI "IMAGENAME eq Hwp.exe" /FO CSV /NH',
                             shell=True, capture_output=True).stdout
    except Exception:
        return set()
    out = out.decode('cp949', 'ignore')
    return {int(l.split('","')[1]) for l in out.splitlines()
            if l.lower().startswith('"hwp.exe"')}


def _start_dialog_dismisser(pids):
    """우리가 띄운 한글(pids)의 확인창만 자동으로 눌러준다 (백그라운드). 멈추는 함수를 돌려준다.

    🔴 `SetMessageBoxMode` 로 안 막히는 창이 있다. 대표적인 것이
    «상위 버전에서 작성한 문서입니다» — 설치된 한글보다 최신 버전으로 만든 문서를
    열 때 뜬다(실측: 한글 11.0 에서 최근 지원사업 양식들). 한글을 올리지 않는 한
    계속 뜨므로, 뜨면 눌러주는 감시를 둔다.

    🔴 프로세스 번호로 거른다 — 거르지 않으면 «다른 프로그램»의 확인창
    (저장할까요·삭제할까요)까지 눌러버린다.
    """
    try:
        import win32gui
        import win32con
        import win32process
    except ImportError:
        return lambda: None
    import threading
    stop = threading.Event()

    def ours(h):
        try:
            return win32process.GetWindowThreadProcessId(h)[1] in pids
        except Exception:
            return False

    def loop():
        while not stop.is_set():
            wins = []

            def collect(h, _):
                try:
                    if (win32gui.IsWindowVisible(h) and win32gui.GetClassName(h) == '#32770'
                            and ours(h)):
                        wins.append(h)
                except Exception:
                    pass
                return True
            try:
                win32gui.EnumWindows(collect, None)
            except Exception:
                pass
            for hwnd in wins:
                btn = []

                def findbtn(h, _):
                    try:
                        if win32gui.GetClassName(h) == 'Button':
                            t = win32gui.GetWindowText(h)
                            if '확인' in t or '예' in t or t.upper().startswith('OK'):
                                btn.append(h)
                    except Exception:
                        pass
                    return True
                try:
                    win32gui.EnumChildWindows(hwnd, findbtn, None)
                    if btn:
                        win32gui.SendMessage(btn[0], win32con.BM_CLICK, 0, 0)
                    else:
                        win32gui.PostMessage(hwnd, win32con.WM_COMMAND, win32con.IDOK, 0)
                except Exception:
                    pass
            time.sleep(0.1)

    threading.Thread(target=loop, daemon=True).start()
    return stop.set


class Hancom:
    """한글 하나를 «새로» 띄워 쓰고 끝나면 그것만 닫는다.

        with Hancom() as h:
            h.Open(...)

    🔴 `taskkill /IM Hwp.exe` 로 정리하지 말 것 — 사람이 열어 둔 한글까지 죽고
       다음에 켤 때 «문서 복구» 창이 뜬다. `Dispatch` 는 부를 때마다 새 한글을
       띄우므로(10/22 실측: 세 번 부르면 프로세스 셋) 죽일 필요가 없다.
    🔴 `gencache.EnsureDispatch` 를 쓰지 말 것 — 설치 캐시가 해시별로 갈려 있어
       옛 캐시를 읽고 깨진다. 동적 `Dispatch` 만 쓴다.
    🔴 «새 한글이 안 생겼으면» 멈춘다 — 떠 있는 한글에 붙으면 사람이 작업 중인
       문서 창에 우리 파일이 열려 그 문서를 덮는다(pyhwpx `Hwp()` 가 그렇게 붙는다).
    """

    def __enter__(self):
        if sys.platform != 'win32':
            sys.exit('이 명령은 한컴오피스가 깔린 Windows 에서만 됩니다.\n'
                     '  · 조사(inspect)와 검수(verify)는 어디서나 됩니다.\n'
                     '  · .hwpx 끼리의 편집(replace·color-dates·margin)도 한컴 없이 됩니다.')
        try:
            import win32com.client as w
        except ImportError:
            sys.exit('pywin32 가 필요합니다:  pip install pywin32')
        mod = _ensure_security_module()
        before = _hwp_pids()
        try:
            self.h = w.Dispatch('HWPFrame.HwpObject')
        except Exception as e:
            sys.exit('한글을 띄우지 못했습니다. 한컴오피스가 설치돼 있는지 확인해주세요.\n  %s' % e)
        mine = set()
        for _ in range(20):
            mine = _hwp_pids() - before
            if mine:
                break
            time.sleep(0.1)
        if not mine:
            sys.exit('새 한글을 띄우지 못하고 이미 떠 있는 한글에 붙었습니다.\n'
                     '  열려 있는 문서를 덮을 수 있어 멈춥니다 — 한글 문서를 저장·닫은 뒤 다시 해주세요.')
        self.pids = mine
        self._stop = _start_dialog_dismisser(mine)
        self.h.SetMessageBoxMode(0xFFFFFF)
        if mod:
            # 🔴 두 번째 인자는 **레지스트리에 등록한 이름과 같아야** 한다(SECURITY_MODULE).
            self.h.RegisterModule('FilePathCheckDLL', mod)
        try:
            # 창을 숨긴다 — 여러 파일을 잇달아 처리할 때 화면이 깜빡이지 않는다
            self.h.XHwpWindows.Item(0).Visible = False
        except Exception:
            pass
        return self.h

    def __exit__(self, *exc):
        try:
            self.h.Clear(1)      # 저장 안 함 — 저장은 SaveAs 로 이미 끝났다
            self.h.Quit()
        except Exception:
            pass
        self._stop()
        return False


def _open(h, path):
    """열고 쪽수를 돌려준다. 못 열면 None.
    🔴 반환값만 믿지 말 것 — 내용이 깨졌을 때 한글은 조용히 빈 문서를 연다."""
    fmt = 'HWPX' if path.lower().endswith('.hwpx') else 'HWP'
    ok = h.Open(os.path.abspath(path), fmt, 'forceopen:true')
    pages = h.PageCount
    return pages if ok and pages >= 1 else None


def convert(src, dst, pdf=None, baseline_src=None):
    """src(.hwp/.hwpx) 를 dst(.hwp/.hwpx/.pdf) 로 바꾼다. pdf 를 주면 함께 뽑는다.
    baseline_src 를 주면 그 파일의 쪽수도 같은 한글에서 재서 돌려준다.
    {'pages': 결과 쪽수, 'baseline_pages': 기준 쪽수|None}"""
    fmts = {'.hwp': 'HWP', '.hwpx': 'HWPX', '.pdf': 'PDF'}
    ext = os.path.splitext(dst)[1].lower()
    if ext not in fmts:
        sys.exit('결과 파일은 .hwp / .hwpx / .pdf 중 하나여야 합니다: %s' % dst)
    with Hancom() as h:
        base_pages = None
        if baseline_src:
            base_pages = _open(h, baseline_src)
            h.Clear(1)
        pages = _open(h, src)
        if pages is None:
            sys.exit('한글이 이 파일을 제대로 열지 못했습니다: %s\n'
                     'XML 이 깨졌거나 줄배치가 어긋났을 가능성이 큽니다(함정 ①⑨).' % src)
        h.SaveAs(os.path.abspath(dst), fmts[ext], '')
        if pdf:
            h.SaveAs(os.path.abspath(pdf), 'PDF', '')
    for f in (dst, pdf):
        if f and not os.path.exists(f):
            sys.exit('변환 실패 — 파일이 만들어지지 않았습니다: %s' % f)
    return {'pages': pages, 'baseline_pages': base_pages}


def cmd_to_hwpx(src, dst):
    r = convert(src, dst)
    print('원본 %d쪽\n%s (%d KB)' % (r['pages'], dst, os.path.getsize(dst) // 1024))


def cmd_to_hwp(src, dst, pdf=None):
    r = convert(src, dst, pdf)
    print('%d쪽 — %s%s' % (r['pages'], dst, (' + ' + pdf) if pdf else ''))


# ────────────────────────────────────────────────────────────
# 조사
# ────────────────────────────────────────────────────────────

def cmd_inspect(path):
    if not path.lower().endswith('.hwpx'):
        sys.exit('.hwpx 를 넣어주세요. .hwp 라면 먼저:  hwpform.py to-hwpx <입력> <출력>\n'
                 '(구조만 훑을 거라면 hwp-mcp 의 read_hwp / read_hwp_tables 가 더 빠릅니다)')
    secs = H.sections(path)
    print('구역 %d개: %s\n' % (len(secs), ', '.join(os.path.basename(s) for s in secs)))
    for sec in secs:
        xml = H.read(path, sec)
        cells = H.dump_cells(xml)
        empt = sum(1 for c in cells if c[4])
        print('=== %s — 칸 %d개 (빈칸 %d) ===' % (os.path.basename(sec), len(cells), empt))
        for idx, r, c, t, empty in cells:
            print('  #%3d (r%-2d,c%-2d) %s %r' % (idx, r, c, '[빈칸]' if empty else '      ', t[:52]))
        pics = len(re.findall(r'<hp:pic ', xml))
        paras = len(re.findall(r'<hp:p ', xml))
        print('  -- 문단 %d / 그림 %d\n' % (paras, pics))

    print('=== 표 목록 (table-split --table 번호) ===')
    k = 0
    for sec in secs:
        xml = H.read(path, sec)
        for a, b in H.tables(xml):
            k += 1
            first = H.text_nodes(xml[a:b])
            print('  표 %d  %s  %d행  첫 글자 %r' % (k, os.path.basename(sec), len(H.table_rows(xml[a:b])),
                                               first[0]['inner'][:30] if first else ''))
    print('')

    hdr = H.read(path, 'Contents/header.xml')
    props = H.char_props(hdr)
    body = {k: v for k, v in props.items() if v['color'] == '#000000'}
    print('=== 본문에 쓸 만한 글꼴 서식 (검정) ===')
    for cid, v in sorted(body.items(), key=lambda x: int(x[0]))[:14]:
        print('  charPr %-3s  %4.1fpt  자간 %s' % (cid, v['height'] / 100, v['spacing']))
    print('\n  🔴 서식 번호는 반드시 이 양식에서 고를 것 (다른 파일의 같은 번호는 다른 서식)')
    print('=== 여백 (mm) ===')
    print('  ' + '  '.join('%s=%.1f' % (k, v) for k, v in H.get_margins(
        H.read(path, H.SEC0)).items()))


# ────────────────────────────────────────────────────────────
# 검수
# ────────────────────────────────────────────────────────────

def cmd_verify(pdf, expect_pages=None, baseline=None, absent=None, expect_red=None,
               red_color='#DC0000', min_images=None, expect_left_mm=None, expect_portrait=None,
               present=None):
    try:
        import fitz
    except ImportError:
        sys.exit('PyMuPDF 가 필요합니다:  pip install pymupdf')

    problems = []
    d = fitz.open(pdf)
    if expect_pages is not None and len(d) != expect_pages:
        problems.append('쪽수 %d (기대 %d)' % (len(d), expect_pages))
    print('쪽수 %d%s' % (len(d), '' if expect_pages is None else
                       ('  (기대 %d — %s)' % (expect_pages,
                        'OK' if len(d) == expect_pages else '!! 불일치'))))

    # 🔴 get_images + get_image_rects 로 세지 말 것 — 내용이 같은 그림(같은 도장 두 번)은
    #    서로의 자리까지 잡혀 두 배로 센다. 그려진 자리마다 하나씩 주는 get_image_info 를 쓴다.
    imgs = []
    for i, p in enumerate(d):
        for info in p.get_image_info():
            r = fitz.Rect(info['bbox'])
            imgs.append((i + 1, r.width / 72 * 25.4, r.height / 72 * 25.4,
                         r.x0 / 72 * 25.4, r.y0 / 72 * 25.4))
    print('그림 %d개' % len(imgs))
    for pg, w, h, x, y in imgs[:20]:
        print('  p%d  %5.1f x %5.1f mm  @ (%5.1f, %5.1f) mm' % (pg, w, h, x, y))
    if len(imgs) > 20:
        print('  … 외 %d개 (반투명 그림은 띠 여러 장으로 쪼개져 나온다)' % (len(imgs) - 20))
    if min_images is not None and len(imgs) < min_images:
        print('!! 파일 속 그림은 %d개인데 PDF 에는 %d개' % (min_images, len(imgs)))
        problems.append('빠진 그림 %d' % (min_images - len(imgs)))
    # 그림끼리 겹침 — 같은 도장이 두 번 찍힌 것을 잡는다(10/22 실측).
    # 🔴 쌍마다 «겹친 폭이 1mm 넘나»로 보면 못 잡는다 — 반투명 도장은 0.7mm 띠로 쪼개져 나와서
    #    두 도장이 포개져도 띠 한 쌍의 겹친 높이는 1mm 가 안 된다. 쪽마다 겹친 «넓이»를 더한다.
    #    (한 도장의 띠끼리는 경계만 닿아 넓이가 0 에 가깝다)
    #    반투명 그림의 타일(통그림 안에 든 조각)은 먼저 뺀다(_drop_contained).
    over = _overlap_area([(pg, x, y, x + w, y + h) for pg, w, h, x, y in imgs])
    over = {pg: round(v, 1) for pg, v in over.items() if v > 4}
    if over:
        print('!! 그림끼리 겹친 넓이(mm²) 쪽별: %r — 같은 도장이 두 번 찍혔나 볼 것' % over)
        problems.append('그림 겹침 %d쪽' % len(over))

    xs = [l['bbox'] for b in d[0].get_text('dict')['blocks'] for l in b.get('lines', [])]
    if xs:
        print('1쪽 본문 범위: 좌 %.1f  상 %.1f  우끝 %.1f  하 %.1f mm  (종이 %.0f x %.0f)'
              % (min(x[0] for x in xs) / 72 * 25.4, min(x[1] for x in xs) / 72 * 25.4,
                 max(x[2] for x in xs) / 72 * 25.4, max(x[3] for x in xs) / 72 * 25.4,
                 d[0].rect.width / 72 * 25.4, d[0].rect.height / 72 * 25.4))
        over = [x for x in xs if x[2] > d[0].rect.width - 5]
        print('종이 밖으로 넘친 줄: %d' % len(over) + ('  !! 확인 필요' if over else ''))
        if over:
            problems.append('넘친 줄 %d' % len(over))
        # 🔴 한글 PDF 가 «2쪽 모아찍기»(0.707배)로 나오는 일이 있다(10/18 실측 — 1쪽이어도 A4 왼쪽 위에 작게).
        #    그대로 두면 도장 자리·크기 재기가 전부 0.707배로 틀리고, 제출본까지 작게 나간다.
        #    파일에 적힌 왼쪽 여백보다 글이 3mm 넘게 왼쪽에서 시작하면 축소로 본다.
        left = min(x[0] for x in xs) / 72 * 25.4
        if expect_left_mm is not None and left < expect_left_mm - 3:
            print('!! 글이 %.1fmm 에서 시작 — 파일의 왼쪽 여백은 %.1fmm. PDF 가 축소돼 나왔다(모아찍기?)'
                  % (left, expect_left_mm))
            problems.append('PDF 축소 의심 (왼쪽 %.1f < 여백 %.1f)' % (left, expect_left_mm))
    if expect_portrait and d[0].rect.width > d[0].rect.height:
        print('!! 세로 문서인데 PDF 가 가로 종이 — 2쪽 모아찍기로 나왔다')
        problems.append('PDF 가로 (모아찍기 의심)')

    txt = '\n'.join(p.get_text() for p in d)
    print('글자수 %d' % len(txt))

    if present:
        flat = re.sub(r'\s+', '', txt)
        miss = [k for k in present if re.sub(r'\s+', '', k) not in flat]
        if miss:
            print('!! 넣었는데 PDF 에 안 보이는 글자 %d줄: %r' % (len(miss), [m[:30] for m in miss[:5]]))
            problems.append('빠진 글자 %d줄' % len(miss))
        else:
            print('넣은 글자 %d줄 — 전부 PDF 에 있음' % len(present))

    if absent:
        flat = re.sub(r'\s+', '', txt)
        left = [(k, flat.count(re.sub(r'\s+', '', k))) for k in absent]
        left = [(k, c) for k, c in left if c]
        if left:
            print('!! 남아 있으면 안 되는 옛 글자: %r' % left)
            problems.append('옛 글자 %d종' % len(left))
        else:
            print('옛 글자 %d종 — 0곳 남음' % len(absent))

    if expect_red is not None:
        want = int(red_color.lstrip('#'), 16)
        groups, cur = [], ''
        for p in d:
            for b in p.get_text('dict')['blocks']:
                for l in b.get('lines', []):
                    for sp in l['spans']:
                        if sp['color'] == want:
                            cur += sp['text']
                        elif sp['text'].strip():
                            if cur:
                                groups.append(cur)
                            cur = ''
        if cur:
            groups.append(cur)
        n_red = sum(len(re.findall(H.DATE_RE, g)) for g in groups)
        print('빨간 날짜 %d곳 (기대 %d)' % (n_red, expect_red) + ('' if n_red == expect_red else '  !! 불일치'))
        if n_red != expect_red:
            problems.append('빨간 날짜 %d (기대 %d)' % (n_red, expect_red))

    leftover = re.findall(r'(20\d\s*년\s+월|\(\s*우편\s*:\s+\)|년\s+월\s+일)', txt)
    if leftover:
        print('!! 안 채운 자리로 보이는 곳 %d건: %r' % (len(leftover), leftover[:5]))
    else:
        print('안 채운 자리(연월일·우편번호 빈칸) 없음')

    if baseline and os.path.exists(baseline):
        import difflib
        b = fitz.open(baseline)
        bt = '\n'.join(p.get_text() for p in b)
        same = re.sub(r'\s+', '', bt) == re.sub(r'\s+', '', txt)
        print('\n기준 파일과 대조: 쪽수 %d -> %d / 글자 %d -> %d / 공백무시 일치 %s'
              % (len(b), len(d), len(bt), len(txt), same))
        if not same:
            diff = [l for l in difflib.unified_diff(
                bt.split('\n'), txt.split('\n'), lineterm='', n=0)
                if not l.startswith(('+++', '---', '@@'))]
            for l in diff[:20]:
                print('  ' + l)

    print('\n🔴 마지막 판정은 사람이 한다 — 한글로 열어 눈으로 볼 것.')
    return problems


# ────────────────────────────────────────────────────────────
# 편집 명령 — 열기 → XML 편집 → 건수 대조 → 저장 → (한컴) PDF → verify
# ────────────────────────────────────────────────────────────

HEADER = 'Contents/header.xml'   # 🔴 H.HPF 가 아니다(함정 ⑭) — 글자 서식은 여기


def run_edit(src, dst, edit, pdf=None, expect_pages=None):
    """모든 편집 명령이 지나는 한 길.

    src  : .hwp 또는 .hwpx (원본은 절대 덮어쓰지 않는다)
    dst  : .hwpx 면 한컴 없이 끝난다 / .hwp 면 한컴으로 바꾸고 같은 이름 .pdf 도 뽑는다
    edit : parts{zip 안 경로: XML} 를 고치고 True(저장) / False(멈춤) 를 돌려주는 함수
    """
    if os.path.abspath(src).lower() == os.path.abspath(dst).lower():
        sys.exit('원본을 덮어쓸 수 없습니다 — 결과 파일 이름을 따로 주세요(양식이 깨지면 처음부터다).')
    if not os.path.exists(src):
        sys.exit('파일이 없습니다: %s' % src)
    tmp = tempfile.mkdtemp(prefix='hwpform-')
    work, src_pages = src, None
    if src.lower().endswith('.hwp'):
        work = os.path.join(tmp, 'in.hwpx')
        src_pages = convert(src, work)['pages']
        print('원본 %d쪽 → 작업용 hwpx' % src_pages)
    elif not src.lower().endswith('.hwpx'):
        sys.exit('.hwp 또는 .hwpx 를 넣어주세요: %s' % src)

    names = H.sections(work) + [HEADER, H.HPF]
    before = {n: H.read(work, n) for n in names}
    parts = dict(before)
    ctx = {'work': work, 'tmp': tmp, 'adds': {}, 'verify': {}}
    if not edit(parts, ctx):
        sys.exit('🔴 멈춤 — 아무것도 저장하지 않았습니다(위 사유).')
    H.check_wellformed(**{n.replace('/', '_').replace('.', '_'): parts[n] for n in names})
    changed = {n: parts[n] for n in names if parts[n] != before[n]}
    # 그림이 PDF 에 다 나왔나 — 파일 속 그림 수보다 PDF 의 그림이 적으면 어딘가 빠졌다
    ctx['verify'].setdefault('min_images', sum(
        len(re.findall(r'<hp:pic\b', parts[n])) for n in names if n.startswith('Contents/section')))
    # PDF 가 축소·모아찍기로 나왔나 — 첫 구역의 여백·종이 방향을 기준으로 준다
    sec0 = parts[names[0]]
    lefts = H.get_margins(sec0)
    pp = re.search(r'<hp:pagePr\b[^>]*\bwidth="(\d+)" height="(\d+)"', sec0)
    if lefts:
        ctx['verify'].setdefault('expect_left_mm', lefts['left'] + lefts.get('gutter', 0))
    if pp:
        ctx['verify'].setdefault('expect_portrait', int(pp.group(1)) < int(pp.group(2)))
    if not changed:
        sys.exit('🔴 바뀐 것이 0건입니다 — 저장하지 않았습니다.')

    ext = os.path.splitext(dst)[1].lower()
    if ext == '.hwpx':
        H.save(work, dst, replaced=changed, add_files=ctx['adds'])
        print('저장: %s' % dst)
        if not pdf:
            print('(PDF 검수를 하려면 --pdf <파일.pdf> — 한컴 필요)')
            return
        r = convert(dst, pdf, baseline_src=None if src_pages else src)
    elif ext == '.hwp':
        out_hwpx = os.path.join(tmp, 'out.hwpx')
        H.save(work, out_hwpx, replaced=changed, add_files=ctx['adds'])
        pdf = pdf or os.path.splitext(dst)[0] + '.pdf'
        r = convert(out_hwpx, dst, pdf, baseline_src=None if src_pages else src)
        print('저장: %s + %s' % (dst, pdf))
    else:
        sys.exit('결과 파일은 .hwp 또는 .hwpx 여야 합니다: %s' % dst)

    want = expect_pages or src_pages or r['baseline_pages']
    print('')
    problems = cmd_verify(pdf, want, **ctx['verify'])
    if problems:
        sys.exit('🔴 검수 실패 %d건 — %s' % (len(problems), ' / '.join(problems)))


def _load_map(path, pairs):
    """{찾을: (바꿀, 기대건수|None)} — JSON 또는 「찾을 => 바꿀」 줄 파일 + --set 쌍."""
    out = {}
    if path:
        raw = open(path, encoding='utf-8-sig').read()
        if path.lower().endswith('.json'):
            for k, v in json.loads(raw).items():
                if isinstance(v, dict):
                    out[k] = (v['to'], v.get('count'))
                else:
                    out[k] = (v, None)
        else:
            for ln in raw.splitlines():
                if not ln.strip() or ln.lstrip().startswith('#'):
                    continue
                if '=>' not in ln:
                    sys.exit('바꿀 목록 줄은 「찾을 => 바꿀」 모양이어야 합니다: %r' % ln)
                k, v = ln.split('=>', 1)
                out[k.strip()] = (v.strip(), None)
    for p in pairs or []:
        if '=>' not in p:
            sys.exit('--set 은 「찾을=>바꿀」 모양이어야 합니다: %r' % p)
        k, v = p.split('=>', 1)
        out[k.strip()] = (v.strip(), None)
    if not out:
        sys.exit('바꿀 것이 없습니다 — --map 파일이나 --set 「찾을=>바꿀」 을 주세요.')
    if '' in out:
        sys.exit('빈 글자는 찾을 수 없습니다.')
    return out


def cmd_replace(a):
    """글자 바꾸기 — 서식 유지 · 건수 대조 · 옛 글자 잔존 검사."""
    m = _load_map(a.map, a.set)

    def edit(parts, ctx):
        total = {k: 0 for k in m}
        for n in _sections(parts):
            parts[n], c = H.replace_map(parts[n], {k: v[0] for k, v in m.items()})
            for k, v in c.items():
                total[k] += v
        bad = []
        print('바꾼 건수:')
        for k, (to, want) in m.items():
            got = total[k]
            flag = ''
            if got == 0:
                flag = '  !! 0건'
                bad.append(k)
            elif want is not None and got != want:
                flag = '  !! 기대 %d건' % want
                bad.append(k)
            print('  %3d  %r → %r%s' % (got, k, to, flag))
        # 옛 글자 잔존 — 서식 경계로 조각나 한 조각 안에서 안 맞은 것
        left = {}
        for n in _sections(parts):
            for txt in H.para_texts(parts[n]).values():
                for k, (to, _) in m.items():
                    if k not in to:
                        c = txt.count(escape(k))
                        if c:
                            left[k] = left.get(k, 0) + c
        for k, c in left.items():
            print('  !! 옛 글자가 %d곳 남음: %r — 서식 경계로 조각나 있다. inspect 로 칸을 찾아 '
                  'set_cell_whole 로' % (c, k))
        if bad:
            print('🔴 대상 %d개 중 %d개가 기대와 다릅니다: %r' % (len(m), len(bad), bad))
        ctx['verify']['absent'] = [k for k, (to, _) in m.items() if k not in to]
        return not bad and not left

    run_edit(a.src, a.dst, edit, a.pdf, a.expect_pages)


def cmd_color_dates(a):
    """날짜 글자만 빨갛게 — 그 글자의 서식을 복제해 색만 바꾼다."""
    if a.only:
        lits = [x for x in a.only.split('|') if x.strip()]
        pattern = '|'.join(re.escape(x) for x in sorted(lits, key=len, reverse=True))
    else:
        pattern = H.DATE_RE

    def edit(parts, ctx):
        cache, hits, already = {}, [], []
        for n in _sections(parts):
            parts[n], parts[HEADER], h, al = H.color_matches(
                parts[n], parts[HEADER], pattern, a.color, cache)
            hits += h
            already += al
        print('칠한 날짜 %d곳%s' % (len(hits), ('  (이미 그 색 %d곳)' % len(already)) if already else ''))
        for x in hits:
            print('  · %s' % x)
        if a.only:
            miss = [x for x in lits if not any(x in h for h in hits + already)]
            if miss:
                print('🔴 못 찾은 날짜 %d개: %r — 글자가 조각나 있거나 띄어쓰기가 다르다' % (len(miss), miss))
                return False
        if a.expect is not None and len(hits) + len(already) != a.expect:
            print('🔴 기대 %d곳인데 %d곳' % (a.expect, len(hits) + len(already)))
            return False
        if not hits:
            print('🔴 칠할 날짜가 0곳입니다.')
            return False
        ctx['verify'].update(expect_red=len(hits) + len(already), red_color=a.color)
        return True

    run_edit(a.src, a.dst, edit, a.pdf, a.expect_pages)


def cmd_margin(a):
    """여백을 mm 명시값으로 — 모든 구역에 같은 값."""
    want = {k: getattr(a, k) for k in H.MARGIN_KEYS if getattr(a, k) is not None}
    if not want:
        sys.exit('바꿀 여백을 하나 이상 주세요: --top/--bottom/--left/--right/--header/--footer (mm)')

    def edit(parts, ctx):
        for n in _sections(parts):
            old = H.get_margins(parts[n])
            if not old:
                continue
            parts[n] = H.set_margins(parts[n], **want)
            new = H.get_margins(parts[n])
            print('%s: %s' % (os.path.basename(n), '  '.join(
                '%s %.1f→%.1f' % (k, old[k], new[k]) for k in want)))
        return True

    run_edit(a.src, a.dst, edit, a.pdf, a.expect_pages)


def _sections(parts):
    return [n for n in parts if n.startswith('Contents/section')]


def cmd_pics(a):
    """칸 하나에 그림 여러 장을 표로 — 원본 해상도 그대로."""
    try:
        row, col = [int(v) for v in a.cell.split(',')]
    except Exception:
        sys.exit('--cell 은 「행,열」 모양: 예 11,0 (inspect 의 rN,cN)')
    for p in a.images:
        if not os.path.exists(p):
            sys.exit('그림 파일이 없습니다: %s' % p)

    def edit(parts, ctx):
        sec = 'Contents/section%d.xml' % a.section
        if sec not in parts:
            print('🔴 구역 %d 이 없습니다' % a.section)
            return False
        ids = H.next_ids(parts[H.HPF], *[parts[n] for n in _sections(parts)])
        try:
            parts[sec], parts[H.HPF], adds, n = H.pics_in_cell(
                parts[sec], parts[H.HPF], row, col, a.images, a.cols, a.captions,
                int(a.width_mm * H.MM) if a.width_mm else None, a.occurrence, ids)
        except (KeyError, ValueError) as e:
            print('🔴 %s' % e)
            return False
        ctx['adds'].update(adds)
        print('(r%d,c%d) 칸에 그림 %d장 — %d장씩 %d줄' % (row, col, n, a.cols, -(-n // a.cols)))
        return True

    run_edit(a.src, a.dst, edit, a.pdf, a.expect_pages)


def cmd_delete_pics(a):
    """지정 글자가 든 문단의 그림만 지운다."""
    def edit(parts, ctx):
        gone = []
        for n in _sections(parts):
            try:
                parts[n], g = H.delete_pics(parts[n], a.near, a.name)
            except LookupError:
                continue
            gone += g
        print('지운 그림 %d개: %r' % (len(gone), gone))
        if not gone:
            print('🔴 %r 문단에 지울 그림이 없습니다' % a.near)
            return False
        if a.expect is not None and len(gone) != a.expect:
            print('🔴 기대 %d개인데 %d개' % (a.expect, len(gone)))
            return False
        return True

    run_edit(a.src, a.dst, edit, a.pdf, a.expect_pages)


def cmd_table_split(a):
    """쪽을 못 넘는 표를 N줄씩 나눈다 (머리 줄은 표마다 되풀이)."""
    def edit(parts, ctx):
        found = []
        for n in _sections(parts):
            for sp in H.tables(parts[n]):
                found.append((n, sp))
        if a.table:
            if not 1 <= a.table <= len(found):
                print('🔴 표는 1~%d번 — inspect 의 「표 목록」 번호' % len(found))
                return False
            pick = found[a.table - 1]
        else:
            hits = [(n, sp) for n, sp in found if escape(a.contains) in parts[n][sp[0]:sp[1]]]
            if not hits:
                print('🔴 %r 가 든 표가 없습니다' % a.contains)
                return False
            pick = min(hits, key=lambda t: t[1][1] - t[1][0])   # 가장 안쪽(작은) 표
        n, sp = pick
        ids = H.next_ids(parts[H.HPF], *[parts[s] for s in _sections(parts)])
        try:
            parts[n], k = H.split_table(parts[n], sp, a.rows, a.header, a.page_break, ids['obj'])
        except ValueError as e:
            print('🔴 %s' % e)
            return False
        print('표 하나를 %d개로 나눴습니다 (머리 %d줄 + 본문 %d줄씩)' % (k, a.header, a.rows))
        return True

    run_edit(a.src, a.dst, edit, a.pdf, a.expect_pages)


def _parse_cell_key(k):
    """'행,열' 또는 '행,열@몇번째' (같은 주소 칸이 여럿일 때 — 표 안 표)."""
    m = re.fullmatch(r'\s*(\d+)\s*,\s*(\d+)\s*(?:@\s*(\d+))?\s*', k)
    if not m:
        raise ValueError('칸 주소는 「행,열」 또는 「행,열@몇번째」: %r' % k)
    return int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)


def cmd_fill(a):
    """칸 주소로 값을 통째로 넣는다 — 여러 줄은 줄마다 문단 · 그림 든 칸 거부 · 옛 값 잔존 검사."""
    cells = {}
    if a.cells:
        cells.update(json.loads(open(a.cells, encoding='utf-8-sig').read()))
    for p in a.set or []:
        if '=' not in p:
            sys.exit('--set 은 「행,열=값」 모양이어야 합니다: %r' % p)
        k, v = p.split('=', 1)
        cells[k] = v
    if not cells:
        sys.exit('채울 칸이 없습니다 — --cells 칸.json 이나 --set "행,열=값" 을 주세요.')
    try:
        addr = {k: _parse_cell_key(k) for k in cells}
    except ValueError as e:
        sys.exit(str(e))
    for k, v in cells.items():
        if not isinstance(v, str):
            sys.exit('값은 글자여야 합니다: %r → %r' % (k, v))
    sec = 'Contents/section%d.xml' % a.section

    def edit(parts, ctx):
        if sec not in parts:
            print('🔴 구역 %d 이 없습니다' % a.section)
            return False
        xml, old, bad = parts[sec], [], []
        for k, (r, c, o) in addr.items():
            try:
                sp = H._span_of(xml, r, c, o)
                old += H.para_texts(xml[sp[3]:sp[4]]).values()
                xml = H.set_cell_lines(xml, r, c, cells[k], o)
            except (KeyError, ValueError) as e:
                print('🔴 %s: %s' % (k, e))
                bad.append(k)
        if bad:
            return False
        parts[sec] = xml
        lines = {k: v.replace('\r\n', '\n').replace('\r', '\n').split('\n') for k, v in cells.items()}
        new_all = '\n'.join(cells.values())
        print('채운 칸 %d개:' % len(cells))
        for k, ls in lines.items():
            print('  (%s) %d줄  %r' % (k, len(ls), ' / '.join(ls)[:50]))
        ctx['verify']['present'] = [ln.strip() for ls in lines.values() for ln in ls if ln.strip()]
        # 옛 값 잔존 — 옛 서류를 틀로 썼을 때(함정 ㉑). 새 값에도 있는 글자는 빼고 본다.
        ctx['verify']['absent'] = sorted({unescape(t).strip() for t in old
                                          if len(t.strip()) >= 2 and unescape(t).strip() not in new_all})
        if a.min_images is not None:
            ctx['verify']['min_images'] = a.min_images
        return True

    run_edit(a.src, a.dst, edit, a.pdf, a.expect_pages)


def _anchor_rects(pdf, text):
    """PDF 에서 text 가 그려진 자리들 [(쪽 번호, 가운데 x mm, 가운데 y mm)] — 문서 순서."""
    import fitz
    out = []
    for i, p in enumerate(fitz.open(pdf)):
        for r in p.search_for(text):
            out.append((i, (r.x0 + r.x1) / 2 / 72 * 25.4, (r.y0 + r.y1) / 2 / 72 * 25.4))
    return out


def _drop_contained(rects, tol=0.05):
    """더 큰 그림 «안에 완전히 든» 작은 조각을 뺀다 [(쪽, x0, y0, x1, y1)].

    🔴 반투명 PNG 는 한컴 PDF 에서 «통그림 1장 + 그 위 0.7mm 타일 수백 장»으로 나온다(10/22 실측: 도장 1개 = 그림 532개).
       타일을 그대로 두면 겹침 검사가 모든 반투명 그림을 «겹침»으로 오판한다.
    🔴 크기가 «같은» 그림은 빼지 않는다 — 같은 자리에 두 번 찍힌 도장이 그 모양이다.
    """
    def area(r):
        return (r[3] - r[1]) * (r[4] - r[2])
    out = []
    for r in rects:
        inside = any(s is not r and s[0] == r[0] and area(s) > area(r) * 1.05 and
                     s[1] - tol <= r[1] and s[2] - tol <= r[2] and r[3] <= s[3] + tol and r[4] <= s[4] + tol
                     for s in rects)
        if not inside:
            out.append(r)
    return out


def _overlap_area(rects):
    """{쪽: 그림끼리 겹친 넓이 mm²} — 타일을 뺀 뒤에 센다."""
    rects = _drop_contained(rects)
    over = {}
    for i in range(len(rects)):
        for j in range(i + 1, len(rects)):
            a, b = rects[i], rects[j]
            if a[0] != b[0]:
                continue
            ix = min(a[3], b[3]) - max(a[1], b[1])
            iy = min(a[4], b[4]) - max(a[2], b[2])
            if ix > 0 and iy > 0:
                over[a[0]] = over.get(a[0], 0) + ix * iy
    return over


def _cluster(rects, seed, tol=0.5):
    """seed 와 닿아 있는 조각들을 이어 붙인 하나의 상자 (쪽, x0, y0, x1, y1).

    🔴 반투명 PNG 도장은 한컴이 PDF 로 낼 때 **가는 띠 수십 장으로 쪼갠다**(10/22 실측: 15mm 도장 = 띠 60여 장).
       조각 하나로 자리를 재면 맞은 것처럼 보이고 실제로는 모른다. 닿는 조각을 모두 묶어서 잰다.
    """
    box = list(seed)
    rest = [r for r in rects if r != seed and r[0] == seed[0]]
    grew = True
    while grew:
        grew = False
        for r in list(rest):
            if (r[1] <= box[3] + tol and r[3] >= box[1] - tol and
                    r[2] <= box[4] + tol and r[4] >= box[2] - tol):
                box = [box[0], min(box[1], r[1]), min(box[2], r[2]), max(box[3], r[3]), max(box[4], r[4])]
                rest.remove(r)
                grew = True
    return tuple(box)


def _image_rects(pdf):
    """[(쪽, x0, y0, x1, y1)] mm."""
    import fitz
    out = []
    for i, p in enumerate(fitz.open(pdf)):
        for info in p.get_image_info():
            out.append((i,) + tuple(round(v / 72 * 25.4, 2) for v in info['bbox']))
    return out


def cmd_stamp(a):
    """「(인)」 같은 글자 위에 도장을 찍는다 — PDF 로 자리를 재서 맞추고, 다시 재서 확인한다.

    🔴 종이 기준 좌표는 본문 문단에 붙이면 여백만큼 밀려 그려진다(함정 ⑧). 그래서 «한 번 찍고
       PDF 로 재서 차이만큼 고쳐 다시 찍는» 것을 사람 대신 이 명령이 한다(한컴 필요).
    """
    if not os.path.exists(a.image):
        sys.exit('도장 그림이 없습니다: %s' % a.image)
    try:
        from PIL import Image
    except ImportError:
        sys.exit('Pillow 가 필요합니다:  pip install pillow  (도장은 픽셀 수가 크기를 정한다 — 함정 ③)')
    name = os.path.basename(a.image)

    def edit(parts, ctx):
        occ = []
        for n in _sections(parts):
            for node, off in H.find_text(parts[n], a.after):
                occ.append((n, node, off))
        if not occ:
            print('🔴 %r 글자가 없습니다' % a.after)
            return False
        if a.all:
            pick = list(range(len(occ)))
        elif a.occurrence:
            if not 1 <= a.occurrence <= len(occ):
                print('🔴 %r 는 %d곳 — --occurrence 1~%d' % (a.after, len(occ), len(occ)))
                return False
            pick = [a.occurrence - 1]
        elif len(occ) == 1:
            pick = [0]
        else:
            print('🔴 %r 가 %d곳입니다 — --occurrence N 또는 --all 로 고르세요' % (a.after, len(occ)))
            return False

        # 같은 이름 도장이 그 문단에 이미 있으면 멈춘다(10/22 실측: 같은 도장이 두 번 찍혔다)
        dup = []
        for i in pick:
            n, node, _ = occ[i]
            dup += [p for p in H.pic_nodes(parts[n]) if p['para'] == node['para'] and p['name'] == name]
        if dup and not a.replace:
            print('🔴 그 자리에 같은 도장(%s)이 이미 %d개 있습니다 — 다시 찍으려면 --replace' % (name, len(dup)))
            return False
        if dup:
            for n in _sections(parts):
                try:
                    parts[n], g = H.delete_pics(parts[n], a.after, name)
                except LookupError:
                    pass
            print('옛 도장 %d개를 걷어냈습니다(--replace)' % len(dup))
            return edit(parts, ctx)
        if len({id(occ[i][1]) for i in pick}) != len(pick):
            print('🔴 한 글자 조각 안에 %r 가 여러 번 있습니다 — --occurrence 로 하나씩 찍으세요' % a.after)
            return False

        # 1) 지금 문서를 PDF 로 — 글자 자리를 잰다
        t0 = os.path.join(ctx['tmp'], 'stamp0.hwpx')
        H.save(ctx['work'], t0, replaced=dict(parts), add_files=ctx['adds'])
        p0 = os.path.join(ctx['tmp'], 'stamp0.pdf')
        convert(t0, p0)
        rects = _anchor_rects(p0, a.after)
        if len(rects) != len(occ):
            print('🔴 파일에는 %r 가 %d곳인데 PDF 에는 %d곳 — 자리를 짝지을 수 없습니다'
                  % (a.after, len(occ), len(rects)))
            return False
        base_imgs = set(_image_rects(p0))

        # 2) 도장 그림을 표시 크기 픽셀로 줄인다
        im = Image.open(a.image)
        w_mm = a.mm
        h_mm = a.mm * im.height / im.width
        small = os.path.join(ctx['tmp'], 'stamp.png')
        im.resize((H.px_for_mm(w_mm), H.px_for_mm(h_mm)), Image.LANCZOS).save(small)
        hpf, iid, arc = H.add_image(parts[H.HPF], H.next_ids(parts[H.HPF])['image'], small)
        adds = dict(ctx['adds'])
        adds[arc] = small
        w, h = int(w_mm * H.MM), int(h_mm * H.MM)
        targets = [(rects[i][0], rects[i][1] - w_mm / 2, rects[i][2] - h_mm / 2) for i in pick]

        def place(shift):
            out = dict(parts)
            out[H.HPF] = hpf
            z = H.next_ids(hpf, *[parts[s] for s in _sections(parts)])['z']
            # 뒤에서부터 끼워야 앞 조각의 위치가 안 밀린다
            for k in sorted(range(len(pick)), key=lambda k: (occ[pick[k]][0], occ[pick[k]][1]['start']),
                            reverse=True):
                n, node, off = occ[pick[k]]
                _pg, x, y = targets[k]
                dx, dy = shift[k]
                nd = H.stamp_node(iid, w, int((x + dx) * H.MM), int((y + dy) * H.MM), z + k, name)
                out[n] = H.insert_after_text(out[n], node, off, a.after, nd)
            return out

        shift = [(0.0, 0.0)] * len(pick)
        for rnd in range(3):
            trial = place(shift)
            t1 = os.path.join(ctx['tmp'], 'stamp%d.hwpx' % (rnd + 1))
            H.save(ctx['work'], t1, replaced=trial, add_files=adds)
            p1 = os.path.join(ctx['tmp'], 'stamp%d.pdf' % (rnd + 1))
            convert(t1, p1)
            new = _drop_contained([r for r in _image_rects(p1) if r not in base_imgs])
            errs, nxt = [], []
            for k, (pg, x, y) in enumerate(targets):
                cand = [r for r in new if r[0] == pg]
                if not cand:
                    print('🔴 %d쪽에 찍힌 도장을 PDF 에서 못 찾았습니다' % (pg + 1))
                    return False
                r = _cluster(cand, min(cand, key=lambda r: abs(r[1] - x) + abs(r[2] - y)))
                if abs((r[3] - r[1]) - w_mm) > 1 or abs((r[4] - r[2]) - h_mm) > 1:
                    print('🔴 PDF 의 도장 크기가 %.1f x %.1fmm — 기대 %.1f x %.1fmm%s'
                          % (r[3] - r[1], r[4] - r[2], w_mm, h_mm,
                             ' (0.7배 — PDF 가 «2쪽 모아찍기»로 축소돼 나왔다)'
                             if abs((r[3] - r[1]) / w_mm - 0.707) < 0.05 else ''))
                    return False
                ex, ey = x - r[1], y - r[2]
                errs.append(max(abs(ex), abs(ey)))
                nxt.append((shift[k][0] + ex, shift[k][1] + ey))
            print('  도장 자리 맞추기 %d회차 — 최대 어긋남 %.1fmm' % (rnd + 1, max(errs)))
            if max(errs) <= 0.5:
                parts.update(trial)
                ctx['adds'].update(adds)
                print('도장 %d개 — %r 위 · %.0fmm' % (len(pick), a.after, w_mm))
                return True
            shift = nxt
        print('🔴 세 번 고쳐도 도장 자리가 0.5mm 안으로 안 맞습니다')
        return False

    run_edit(a.src, a.dst, edit, a.pdf, a.expect_pages)


def main():
    ap = argparse.ArgumentParser(description='한글 양식 작업 — 한 도구', add_help=True)
    sub = ap.add_subparsers(dest='cmd')

    x = sub.add_parser('inspect')
    x.add_argument('path')
    x = sub.add_parser('to-hwpx')
    x.add_argument('src')
    x.add_argument('dst')
    x = sub.add_parser('to-hwp')
    x.add_argument('src')
    x.add_argument('dst')
    x.add_argument('pdf', nargs='?')
    x = sub.add_parser('verify')
    x.add_argument('pdf')
    x.add_argument('--expect-pages', type=int)
    x.add_argument('--baseline')
    x.add_argument('--absent', help='남아 있으면 안 되는 글자 (| 로 구분)')
    x.add_argument('--expect-red', type=int, help='빨간 날짜 수')

    def edit_args(x):
        x.add_argument('src')
        x.add_argument('dst')
        x.add_argument('--pdf')
        x.add_argument('--expect-pages', type=int)

    x = sub.add_parser('replace')
    edit_args(x)
    x.add_argument('--map', help='「찾을 => 바꿀」 줄 파일 또는 {"찾을": "바꿀" | {"to":…, "count":N}} JSON')
    x.add_argument('--set', action='append', help='「찾을=>바꿀」 (여러 번)')
    x = sub.add_parser('color-dates')
    edit_args(x)
    x.add_argument('--only', help='이 날짜들만 (| 로 구분). 안 주면 날짜 모양 전부')
    x.add_argument('--color', default='#DC0000')
    x.add_argument('--expect', type=int, help='칠할 곳 수 (이미 그 색인 곳 포함)')
    x = sub.add_parser('margin')
    edit_args(x)
    for k in H.MARGIN_KEYS:
        x.add_argument('--' + k, type=float)
    x = sub.add_parser('pics')
    edit_args(x)
    x.add_argument('--cell', required=True, help='행,열 (inspect 의 rN,cN)')
    x.add_argument('--section', type=int, default=0)
    x.add_argument('--occurrence', type=int, default=0, help='같은 주소 칸이 여럿일 때(표 안 표) 몇 번째')
    x.add_argument('--cols', type=int, default=1)
    x.add_argument('--images', nargs='+', required=True)
    x.add_argument('--captions', nargs='+')
    x.add_argument('--width-mm', type=float, help='그림 한 장 폭 (없으면 칸 폭 / cols)')
    x = sub.add_parser('stamp')
    edit_args(x)
    x.add_argument('--after', required=True, help='도장을 얹을 글자 — 예 "(인)"')
    x.add_argument('--image', required=True)
    x.add_argument('--mm', type=float, default=15.0, help='도장 폭 mm')
    x.add_argument('--occurrence', type=int, help='그 글자가 여러 곳일 때 몇 번째(1부터)')
    x.add_argument('--all', action='store_true')
    x.add_argument('--replace', action='store_true', help='같은 도장이 이미 있으면 걷어내고 다시')
    x = sub.add_parser('delete-pics')
    edit_args(x)
    x.add_argument('--near', required=True, help='이 글자가 든 문단의 그림만')
    x.add_argument('--name', help='이 이름의 그림만')
    x.add_argument('--expect', type=int)
    x = sub.add_parser('fill')
    edit_args(x)
    x.add_argument('--cells', help='{"행,열": "값", "행,열@1": "여러 줄\\n본문"} JSON (줄바꿈 = 문단)')
    x.add_argument('--set', action='append', help='「행,열=값」 (여러 번)')
    x.add_argument('--section', type=int, default=0)
    x.add_argument('--min-images', type=int, help='PDF 에 최소 이만큼 그림이 나와야 한다 (날인 검사)')
    x = sub.add_parser('table-split')
    edit_args(x)
    g = x.add_mutually_exclusive_group(required=True)
    g.add_argument('--table', type=int, help='inspect 「표 목록」 번호')
    g.add_argument('--contains', help='이 글자가 든 표')
    x.add_argument('--rows', type=int, required=True)
    x.add_argument('--header', type=int, default=1)
    x.add_argument('--page-break', action='store_true', help='나눈 표마다 새 쪽에서')

    a = ap.parse_args()
    if a.cmd == 'inspect':
        cmd_inspect(a.path)
    elif a.cmd == 'to-hwpx':
        cmd_to_hwpx(a.src, a.dst)
    elif a.cmd == 'to-hwp':
        cmd_to_hwp(a.src, a.dst, a.pdf)
    elif a.cmd == 'verify':
        if cmd_verify(a.pdf, a.expect_pages, a.baseline,
                      [k for k in (a.absent or '').split('|') if k] or None, a.expect_red):
            sys.exit(1)
    elif a.cmd == 'replace':
        cmd_replace(a)
    elif a.cmd == 'color-dates':
        cmd_color_dates(a)
    elif a.cmd == 'margin':
        cmd_margin(a)
    elif a.cmd == 'pics':
        cmd_pics(a)
    elif a.cmd == 'stamp':
        cmd_stamp(a)
    elif a.cmd == 'delete-pics':
        cmd_delete_pics(a)
    elif a.cmd == 'table-split':
        cmd_table_split(a)
    elif a.cmd == 'fill':
        cmd_fill(a)
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == '__main__':
    main()
