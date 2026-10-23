# -*- coding: utf-8 -*-
"""hwpx 편집 라이브러리 — 한컴 없이 한글 문서를 채운다.

.hwpx 는 표준 zip + XML 이라 순수 파이썬으로 편집된다. 한컴(COM)은 양 끝
변환(.hwp -> .hwpx, .hwpx -> .hwp/.pdf)에만 쓴다. 이 파일에는 COM 코드가 없다.

여기 담긴 처방은 전부 실측으로 얻은 것이다. 자세한 근거는 ../PROVENANCE.md.

🔴 다른 방법을 시도하기 전에 알아둘 것 — 아래 두 경로는 실측으로 막혔다:
  · .hwp 를 OLE 재구성으로 직접 쓰기: 파일은 만들어지고 자체 파서로도 읽히는데
    **한글이 열지 못한다**(2종 양식 2/2 거부). 쓰기는 반드시 .hwpx 경유.
  · 단순 문자열 치환(content.replace): 아래 함정 6종이 전부 안 걸러진다.
"""
import os
import re
import zipfile
from xml.sax.saxutils import escape

SEC0 = 'Contents/section0.xml'
SEC1 = 'Contents/section1.xml'
HPF = 'Contents/content.hpf'

MM = 283.46          # 1mm = 283.46 HWPUNIT (도장 4275 = 15.08mm 로 역산 검증)
PX_PER_INCH = 96     # 이미지 픽셀 -> 표시 크기 환산 기준 (아래 pic_node 주석 참조)


# ────────────────────────────────────────────────────────────
# 읽기
# ────────────────────────────────────────────────────────────

def read(path, name):
    """hwpx 안의 XML 한 조각을 문자열로 꺼낸다."""
    with zipfile.ZipFile(path) as z:
        return z.read(name).decode('utf-8')


def sections(path):
    """그 hwpx 가 가진 section XML 이름들 (section0, section1 ...)."""
    with zipfile.ZipFile(path) as z:
        return [n for n in z.namelist()
                if n.startswith('Contents/section') and n.endswith('.xml')]


def cell_spans(xml):
    """[(index, row, col, start, end)] — end 는 <hp:cellAddr> 시작 위치.
    start..end 구간이 그 셀의 내용이다.

    🔴 <hp:tc>...</hp:tc> 짝맞춤으로 세지 말 것 — 표 안에 표가 있으면 어긋난다
    (실측: 65개 중 64개만 잡혀 마지막 칸을 통째로 놓쳤다). cellAddr 은 칸마다
    정확히 하나라 순서가 어긋나지 않는다.
    """
    out = []
    for i, m in enumerate(re.finditer(
            r'<hp:cellAddr\s+colAddr="(\d+)"\s+rowAddr="(\d+)"\s*/>', xml)):
        start = xml.rfind('<hp:tc', 0, m.start())
        out.append((i, int(m.group(2)), int(m.group(1)), start, m.start()))
    return out


def cell_text(xml, span):
    """그 칸에 보이는 글자 (여러 조각이면 이어붙인다)."""
    return ''.join(re.findall(r'<hp:t>(.*?)</hp:t>', xml[span[3]:span[4]], re.S))


def dump_cells(xml):
    """[(index, row, col, 텍스트, 빈칸인가)] — 양식 조사용."""
    out = []
    for sp in cell_spans(xml):
        seg = xml[sp[3]:sp[4]]
        empty_run = bool(re.search(r'<hp:run charPrIDRef="\d+"\s*/>', seg))
        out.append((sp[0], sp[1], sp[2], cell_text(xml, sp), empty_run))
    return out


def _span_of(xml, row, col, occurrence=0):
    spans = [s for s in cell_spans(xml) if s[1] == row and s[2] == col]
    if not spans:
        raise KeyError('(r%d,c%d) 칸이 없다' % (row, col))
    if occurrence >= len(spans):
        raise KeyError('(r%d,c%d) 는 %d개뿐인데 %d번째를 찾았다 (중첩 표?)'
                       % (row, col, len(spans), occurrence))
    return spans[occurrence]


# ────────────────────────────────────────────────────────────
# 줄배치 (가장 자주 사고 나는 자리)
# ────────────────────────────────────────────────────────────

def clear_lineseg(xml, start, end):
    """[start,end) 구간의 줄배치 정보를 비운다.

    🔴 값을 바꾼 문단은 반드시 이걸 부를 것. 한글은 저장할 때 문단마다 줄배치를
    계산해 파일에 박아두고, 열 때 **그 값을 그대로 믿는다**. 긴 값을 넣고 옛 배치를
    남겨두면 179자가 한 줄에 그려져 칸 밖으로 넘친다(실측). 비우면 다시 계산한다
    (같은 179자가 24줄로 접혔다).

    🔴 반대로 **글자가 없는 빈 문단까지 비우지는 말 것** — 빈 문단의 배치값은 그
    문단의 실제 높이라, 비우면 한글이 기본 높이로 다시 잡아 쪽이 밀릴 수 있다.
    """
    seg = re.sub(r'<hp:linesegarray>.*?</hp:linesegarray>', '<hp:linesegarray/>',
                 xml[start:end], flags=re.S)
    return xml[:start] + seg + xml[end:]


def clear_lineseg_text_paras(xml):
    """글자가 있는 문단만 줄배치를 비운다 (빈 문단은 그대로 둔다)."""
    def f(m):
        p = m.group(0)
        if '<hp:t>' in p:
            p = re.sub(r'<hp:linesegarray>.*?</hp:linesegarray>',
                       '<hp:linesegarray/>', p, flags=re.S)
        return p
    return re.sub(r'<hp:p.*?</hp:p>', f, xml, flags=re.S)


# ────────────────────────────────────────────────────────────
# 칸 채우기 — 상황별로 함수가 다르다
# ────────────────────────────────────────────────────────────

def set_cell(xml, row, col, value, occurrence=0):
    """빈 칸에 값을 넣는다. 이미 글자가 있으면 첫 조각을 갈아끼운다.

    빈 칸에도 <hp:run charPrIDRef="N"/> 이 이미 들어 있어서, 그 태그를 열어
    글자를 넣기만 하면 **양식이 정한 글꼴·크기가 그대로 유지된다**.
    """
    _, _, _, a, b = _span_of(xml, row, col, occurrence)
    seg, v = xml[a:b], escape(value)
    if re.search(r'<hp:run charPrIDRef="\d+"\s*/>', seg):
        new = re.sub(r'<hp:run charPrIDRef="(\d+)"\s*/>',
                     lambda m: '<hp:run charPrIDRef="%s"><hp:t>%s</hp:t></hp:run>'
                               % (m.group(1), v),
                     seg, count=1)
    elif '<hp:t>' in seg:
        new = re.sub(r'<hp:t>.*?</hp:t>', lambda m: '<hp:t>%s</hp:t>' % v,
                     seg, count=1, flags=re.S)
    else:
        raise ValueError('(r%d,c%d): 글자를 넣을 자리가 없다' % (row, col))
    out = xml[:a] + new + xml[b:]
    sp = _span_of(out, row, col, occurrence)
    return clear_lineseg(out, sp[3], sp[4])


def set_cell_whole(xml, row, col, value, occurrence=0):
    """칸의 글자를 전부 지우고 value 하나만 남긴다.

    한 칸의 글자가 서식 경계마다 여러 조각으로 갈려 있을 때 쓴다
    (실측: 신청분야 칸 = '붙임3 ; ... 자격요건 ' + '붙임3참조' 2조각).
    부분 치환으로는 양식 안내문이 값 옆에 남는다.
    """
    _, _, _, a, b = _span_of(xml, row, col, occurrence)
    seg, first = xml[a:b], [True]

    def f(m):
        if first[0]:
            first[0] = False
            return '<hp:t>%s</hp:t>' % escape(value)
        return '<hp:t></hp:t>'

    seg = re.sub(r'<hp:t>.*?</hp:t>', f, seg, flags=re.S)
    if first[0]:
        return set_cell(xml, row, col, value, occurrence)
    out = xml[:a] + seg + xml[b:]
    sp = _span_of(out, row, col, occurrence)
    return clear_lineseg(out, sp[3], sp[4])


_OBJ_IN_CELL = re.compile(r'<hp:(pic|tbl|ole|container|equation)\b')


def cell_objects(xml, row, col, occurrence=0):
    """그 칸에 든 글자 아닌 것(그림·표 등)의 태그 이름 목록."""
    _, _, _, a, b = _span_of(xml, row, col, occurrence)
    return [m.group(1) for m in _OBJ_IN_CELL.finditer(xml[a:b])]


def set_cell_lines(xml, row, col, value, occurrence=0):
    """칸 내용을 줄마다 한 문단으로 통째로 바꾼다 (여러 줄 본문 칸).

    줄 구분은 \\n (\\r\\n·\\r 도 같은 것으로 본다). 문단 머리(paraPr)와 글자 서식(charPr)은
    그 칸에서 «글자가 든 첫 문단»의 것을 그대로 쓴다 — 양식 서식이 유지된다.
    빈 줄은 빈 문단이 된다.

    @AI:CONSTRAINT 그림·표가 든 칸은 거부한다. 도장은 「(서명)」 칸 «안»의 그림이라
      그 칸을 통째로 바꾸면 날인이 사라진다(9/13 실측 — 사장님이 물어보셔서 발송 직전에 잡혔다).
    """
    objs = cell_objects(xml, row, col, occurrence)
    if objs:
        raise ValueError('(r%d,c%d) 칸에 %s 가 들어 있다 — 통째로 바꾸면 사라진다(도장 칸?)'
                         % (row, col, '/'.join(sorted(set(objs)))))
    _, _, _, a, b = _span_of(xml, row, col, occurrence)
    seg = xml[a:b]
    head = re.match(r'<hp:tc\b[^>]*><hp:subList\b[^>]*>', seg)
    tail = seg.rfind('</hp:subList>')
    if not head or tail < 0:
        raise ValueError('(r%d,c%d): 칸 머리·끝을 못 찾았다' % (row, col))
    paras = re.findall(r'<hp:p\b.*?</hp:p>', seg[head.end():tail], re.S)
    if not paras:
        raise ValueError('(r%d,c%d): 문단이 없다' % (row, col))
    tpl = next((p for p in paras if re.search(r'<hp:t>[^<]', p)), paras[0])
    p_open = re.match(r'<hp:p\b[^>]*>', tpl).group(0)
    cp = re.search(r'<hp:run charPrIDRef="(\d+)"', tpl)
    if not cp:
        raise ValueError('(r%d,c%d): 글자 서식을 못 찾았다' % (row, col))
    cp = cp.group(1)
    lines = value.replace('\r\n', '\n').replace('\r', '\n').split('\n')
    body = ''.join(
        p_open + ('<hp:run charPrIDRef="%s"><hp:t>%s</hp:t></hp:run>' % (cp, escape(ln)) if ln
                  else '<hp:run charPrIDRef="%s"/>' % cp) + '<hp:linesegarray/></hp:p>'
        for ln in lines)
    return xml[:a] + seg[:head.end()] + body + seg[tail:] + xml[b:]


def append_cell(xml, row, col, text, occurrence=0):
    """칸의 마지막 글자 뒤에 이어붙인다 (앞 조각들의 서식을 건드리지 않는다)."""
    _, _, _, a, b = _span_of(xml, row, col, occurrence)
    seg = xml[a:b]
    ms = list(re.finditer(r'<hp:t>(.*?)</hp:t>', seg, re.S))
    if not ms:
        return set_cell(xml, row, col, text, occurrence)
    m = ms[-1]
    seg = seg[:m.start()] + '<hp:t>%s%s</hp:t>' % (m.group(1), escape(text)) + seg[m.end():]
    out = xml[:a] + seg + xml[b:]
    sp = _span_of(out, row, col, occurrence)
    return clear_lineseg(out, sp[3], sp[4])


def prepend_cell(xml, row, col, text, char_pr, occurrence=0):
    """칸의 맨 앞에 새 글자를 끼운다. 글꼴 서식(char_pr)을 직접 지정한다.

    🔴 칸에 뭔가 보인다고 그게 다 '값'은 아니다. 한글 **메모**(주석)는 파일에는
    글자로 들어 있지만 인쇄되지 않는다 — 즉 그 칸은 사실 빈 칸이다. 메모 글자를
    값으로 착각해 갈아치우면, 넣은 값이 안내문 서식(붉은색)으로 메모 안에 들어가
    **결과물에서 사라진다**(실측). 메모는 두고 본문에 값만 끼울 것.
    """
    _, _, _, a, b = _span_of(xml, row, col, occurrence)
    seg = xml[a:b]
    m = re.search(r'<hp:run\b', seg)
    if not m:
        raise ValueError('(r%d,c%d): 글자 자리가 없다' % (row, col))
    ins = '<hp:run charPrIDRef="%s"><hp:t>%s</hp:t></hp:run>' % (char_pr, escape(text))
    out = xml[:a] + seg[:m.start()] + ins + seg[m.start():] + xml[b:]
    sp = _span_of(out, row, col, occurrence)
    return clear_lineseg(out, sp[3], sp[4])


def set_cell_content(xml, row, col, inner, occurrence=0):
    """칸 내용을 통째로 갈아끼운다 (사진을 넣을 때 등).

    🔴 안쪽 구조가 복잡한 칸에 부분 치환을 쓰면 파일이 깨진다. 사진 칸은 누름틀
    안에 또 글자 묶음이 있어서, 최소 매칭 정규식이 안쪽에서 멈추고 닫는 태그만
    남는다(실측: 이 때문에 한글이 빈 문서를 열었다).
    """
    _, _, _, a, b = _span_of(xml, row, col, occurrence)
    seg = xml[a:b]
    m = re.match(r'(<hp:tc\b[^>]*>)(<hp:subList\b[^>]*>)', seg)
    if not m:
        raise ValueError('(r%d,c%d): 칸 머리를 못 찾았다' % (row, col))
    tail = seg.rfind('</hp:subList>')
    if tail < 0:
        raise ValueError('(r%d,c%d): 칸 끝을 못 찾았다' % (row, col))
    return xml[:a] + m.group(1) + m.group(2) + inner + seg[tail:] + xml[b:]


# ────────────────────────────────────────────────────────────
# 글자 치환 (칸 위치를 몰라도 되는 경우)
# ────────────────────────────────────────────────────────────

def replace_text(xml, find, rep):
    """글자 안에서만 치환하고 **몇 건 바뀌었는지 돌려준다**.

    태그 속성은 건드리지 않는다(전체 문자열 치환은 속성값까지 오염시킨다).
    돌려받은 건수를 기대값과 대조할 것 — 0건이면 조각이 갈렸다는 뜻이다.
    """
    n = [0]

    def sub_t(m):
        inner = m.group(1)
        if find in inner:
            n[0] += inner.count(find)
            inner = inner.replace(find, escape(rep))
        return '<hp:t>%s</hp:t>' % inner

    return re.sub(r'<hp:t>(.*?)</hp:t>', sub_t, xml, flags=re.S), n[0]


def replace_after(xml, anchor, new_text):
    """anchor 가 든 글자조각 **바로 다음 조각**을 통째로 바꾼다.

    양식의 '빈칸'이 별도 조각으로 존재할 때 쓴다 (실측: '위와 같이 201 년도 반기'
    / '          ' / '분야 신지식인...' 3조각 — 가운데 공백이 값을 적는 자리다.
    공백만으로는 그 자리를 유일하게 짚을 수 없다).
    """
    ms = list(re.finditer(r'<hp:t>(.*?)</hp:t>', xml, re.S))
    for i, m in enumerate(ms):
        if anchor in m.group(1) and i + 1 < len(ms):
            n = ms[i + 1]
            return xml[:n.start()] + '<hp:t>%s</hp:t>' % escape(new_text) + xml[n.end():], 1
    raise LookupError('앵커 다음 조각이 없다: %r' % anchor)


# ────────────────────────────────────────────────────────────
# 문단 · 그림
# ────────────────────────────────────────────────────────────

def make_para(text, para_pr, char_pr):
    """새 문단 하나. 줄배치는 넣지 않는다(한글이 계산하게).

    🔴 para_pr / char_pr 은 반드시 **채우려는 그 양식**에서 골라야 한다.
    완성본(다른 도구가 만든 파일)에서 번호를 가져오면 안 된다 — 저장할 때
    서식 번호가 다시 매겨져 같은 번호가 다른 서식을 가리킨다
    (실측: 완성본의 16번은 12pt 인데 양식의 16번은 13pt 라, 그대로 썼더니
    본문이 커지고 줄간격이 같은 비율로 벌어져 쪽수가 하나 늘었다).
    """
    body = ('<hp:run charPrIDRef="%s"><hp:t>%s</hp:t></hp:run>' % (char_pr, escape(text))
            if text else '<hp:run charPrIDRef="%s"/>' % char_pr)
    return ('<hp:p id="0" paraPrIDRef="%s" styleIDRef="0" pageBreak="0" '
            'columnBreak="0" merged="0">%s<hp:linesegarray/></hp:p>' % (para_pr, body))


def char_props(header_xml):
    """{서식번호: {height, color, spacing}} — 어떤 번호를 쓸지 고를 때 본다.
    height 1200 = 12pt. 색이 #000000 이 아니면 안내문용일 수 있다."""
    out = {}
    for m in re.finditer(r'<hh:charPr id="(\d+)"[^>]*height="(\d+)"[^>]*?'
                         r'textColor="([^"]+)"', header_xml):
        cid = m.group(1)
        sp = re.search(r'<hh:charPr id="%s".*?<hh:spacing hangul="(-?\d+)"' % cid,
                       header_xml, re.S)
        out[cid] = {'height': int(m.group(2)), 'color': m.group(3),
                    'spacing': int(sp.group(1)) if sp else None}
    return out


def px_for_mm(mm):
    """목표 mm 로 보이게 하려면 이미지를 몇 픽셀로 줄여야 하나.

    🔴 그림 크기는 <hp:sz> 가 아니라 **이미지의 픽셀 수**가 정한다(종이 기준으로
    붙인 그림에서 실측). 152px 짜리 도장에 15.1mm 를 지정했는데 40.3mm 로 그려졌고,
    그 값은 152 / 96dpi = 40.2mm 와 일치했다. 그래서 넣기 전에 미리 줄여야 한다.
    '원본 해상도를 살려 인쇄 품질을 올린다' 는 성립하지 않는다.
    """
    return max(1, round(mm / 25.4 * PX_PER_INCH))


def pic_node(img_id, w, h, orig_w, orig_h, treat_as_char, vert_rel, horz_rel,
             vert_off=0, horz_off=0, clip=(0, 0, 0, 0), z=3, name=''):
    """그림 하나. 길이 단위는 전부 HWPUNIT (1mm = 283.46).

    treat_as_char=1  : 글자처럼 취급 — 칸 안에 넣는 사진
    treat_as_char=0  : 글과 무관하게 떠 있음 — 도장처럼 얹는 것
    vert_rel/horz_rel: 'PAPER'(종이) | 'PARA'(문단) | 'COLUMN'(단)

    🔴 종이 기준(PAPER)이라도 **본문 문단에 붙이면 좌표가 여백 기준으로 읽힌다**
    (실측: 172.7mm 를 줬는데 197.6mm 에 그려졌고 차이가 정확히 왼쪽 여백이었다).
    표 안 문단에 붙였을 때는 그대로 맞았다. 결과 PDF 로 재서 차이만큼 빼줄 것.
    """
    cl, cr, ct, cb = clip
    return (
        '<hp:pic id="%d" zOrder="%d" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" '
        'textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" '
        'instid="%d" reverse="0">'
        '<hp:offset x="0" y="0"/><hp:orgSz width="%d" height="%d"/>'
        '<hp:curSz width="0" height="0"/><hp:flip horizontal="0" vertical="0"/>'
        '<hp:rotationInfo angle="0" centerX="%d" centerY="%d" rotateimage="1"/>'
        '<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>'
        '<hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>'
        '<hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>'
        '<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="%d" y="0"/><hc:pt2 x="%d" y="%d"/>'
        '<hc:pt3 x="0" y="%d"/></hp:imgRect>'
        '<hp:imgClip left="%d" right="%d" top="%d" bottom="%d"/>'
        '<hp:inMargin left="0" right="0" top="0" bottom="0"/>'
        '<hc:img binaryItemIDRef="%s" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/>'
        '<hp:effects/>'
        '<hp:sz width="%d" widthRelTo="ABSOLUTE" height="%d" heightRelTo="ABSOLUTE" protect="0"/>'
        '<hp:pos treatAsChar="%d" affectLSpacing="0" flowWithText="1" allowOverlap="0" '
        'holdAnchorAndSO="0" vertRelTo="%s" horzRelTo="%s" vertAlign="TOP" horzAlign="LEFT" '
        'vertOffset="%d" horzOffset="%d"/>'
        '<hp:outMargin left="0" right="0" top="0" bottom="0"/>'
        '<hp:shapeComment>그림입니다.\n원본 그림의 이름: %s</hp:shapeComment></hp:pic>'
        % (1162460000 + z, z, 88719000 + z, orig_w, orig_h, orig_w // 2, orig_h // 2,
           orig_w, orig_w, orig_h, orig_h, cl, cr, ct, cb, img_id,
           w, h, treat_as_char, vert_rel, horz_rel, vert_off, horz_off, name))


def pic_table(items, tbl_id, z=3, border_fill='2', char_pr='9', para_pr='0'):
    """그림을 담은 **1행 N열 표**를 만든다. items = [(pic_xml, w, h)] (HWPUNIT).

    🔴 문단에 직접 붙인 그림은 **이미지의 픽셀 수**가 크기를 정한다 — `<hp:sz>`,
    `<hp:orgSz>`, 이미지 DPI 메타데이터가 **셋 다 무시**된다(실측). 그래서 크기를
    맞추려면 픽셀을 줄여야 하고 결과가 96dpi 라 인쇄하면 거칠다.
    **표 셀 안에서는 셀 크기가 표시 크기를 정한다** — 원본 1025px 을 그대로 넣어도
    110mm 로 잡혔다(96 → 237dpi). 그림은 되도록 이 함수로 감싸 넣을 것.

    🔴 옛 그림 노드를 지우는 순서에 주의 — 표를 먼저 끼우면 표 **안**의 그림이 같은
    binaryItemIDRef 라, 뒤이은 삭제가 방금 넣은 것을 지운다. 옛 노드를 먼저 걷어낼 것.

    예외: 도장처럼 글자 **옆**에 놓아야 하는 그림은 표로 감싸면 나란히 못 놓는다.
    """
    if not items:
        raise ValueError('items 가 비었다')
    tw = sum(w for _, w, _ in items)
    th = max(h for _, _, h in items)
    tcs = []
    for k, (pic, w, _h) in enumerate(items):
        tcs.append(
            '<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" '
            'borderFillIDRef="%s"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" '
            'vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" '
            'textHeight="0" hasTextRef="0" hasNumRef="0">'
            '<hp:p id="0" paraPrIDRef="%s" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">'
            '<hp:run charPrIDRef="%s">%s</hp:run><hp:linesegarray/></hp:p></hp:subList>'
            '<hp:cellAddr colAddr="%d" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/>'
            '<hp:cellSz width="%d" height="%d"/>'
            '<hp:cellMargin left="0" right="0" top="0" bottom="0"/></hp:tc>'
            % (border_fill, para_pr, char_pr, pic, k, w, th))
    return ('<hp:tbl id="%d" zOrder="%d" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" '
            'textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="0" '
            'rowCnt="1" colCnt="%d" cellSpacing="0" borderFillIDRef="%s" noAdjust="0">'
            '<hp:sz width="%d" widthRelTo="ABSOLUTE" height="%d" heightRelTo="ABSOLUTE" protect="0"/>'
            '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" '
            'holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" '
            'horzAlign="LEFT" vertOffset="0" horzOffset="0"/>'
            '<hp:outMargin left="0" right="0" top="0" bottom="0"/>'
            '<hp:inMargin left="0" right="0" top="0" bottom="0"/>'
            '<hp:tr>%s</hp:tr></hp:tbl>'
            % (tbl_id, z, len(items), border_fill, tw, th, ''.join(tcs)))


def anchor_pic_first_para(xml, pic_xml, char_pr='0'):
    """그림을 **문서 첫 문단**에 매단다.

    🔴 마지막 문단에 매달면 빈 쪽이 생긴다. 종이 기준 절대좌표라 그려지는 위치는
    같은데도 그렇다 — 한글이 그 문단 뒤에 그림 자리를 잡으려 하기 때문으로 보인다
    (실측: 여백·그림속성·좌표가 전부 같은 상태에서 매다는 문단만 바꿔 1쪽 <-> 2쪽).
    """
    p = xml.find('<hp:p ')
    if p < 0:
        raise ValueError('문단이 없다')
    end = xml.find('</hp:p>', p)
    seg = xml[p:end]
    i = seg.rfind('</hp:run>')
    if i < 0:
        raise ValueError('첫 문단에 글자 묶음이 없다')
    ins = '<hp:run charPrIDRef="%s">%s</hp:run>' % (char_pr, pic_xml)
    return xml[:p] + seg[:i + 9] + ins + seg[i + 9:] + xml[end:]


def anchor_pic_in_cell(xml, row, col, pic_xml, char_pr='0', occurrence=-1):
    """그림을 특정 칸의 마지막 문단에 매단다 (표 안 앵커)."""
    spans = [s for s in cell_spans(xml) if s[1] == row and s[2] == col]
    if not spans:
        raise KeyError('(r%d,c%d) 칸이 없다' % (row, col))
    _, _, _, a, b = spans[occurrence]
    p = xml.rfind('<hp:p ', a, b)
    if p < 0:
        raise ValueError('(r%d,c%d): 문단이 없다' % (row, col))
    end = xml.find('</hp:p>', p)
    seg = xml[p:end]
    i = seg.rfind('</hp:run>')
    if i < 0:
        raise ValueError('(r%d,c%d): 글자 묶음이 없다' % (row, col))
    ins = '<hp:run charPrIDRef="%s">%s</hp:run>' % (char_pr, pic_xml)
    return xml[:p] + seg[:i + 9] + ins + seg[i + 9:] + xml[end:]


# ────────────────────────────────────────────────────────────
# 문서 전체 훑기 — 글자 조각이 어느 글자묶음(run)·문단에 속하나
# ────────────────────────────────────────────────────────────

_TOK = re.compile(r'<hp:p\b[^>]*>|</hp:p>|<hp:run\b[^>]*?/>|<hp:run\b[^>]*>|</hp:run>'
                  r'|<hp:t>(.*?)</hp:t>', re.S)


def text_nodes(xml):
    """[{start, end, inner, char_pr, para}] — 글자 조각(<hp:t>)마다 하나.

    para    = (문단 시작, 문단 끝) — 그 조각을 «직접» 담은 가장 안쪽 문단
    char_pr = 그 조각을 «직접» 담은 글자묶음의 서식 번호

    🔴 「바로 앞의 <hp:run」 을 서식으로 읽지 말 것 — 표가 든 글자묶음은 안쪽에
    다른 글자묶음을 품고 있어서, 표 뒤 글자가 표 안 서식으로 잘못 읽힌다.
    그래서 여는 태그·닫는 태그를 쌓아가며 센다.
    """
    out, runs, paras, pend = [], [], [], {}
    for m in _TOK.finditer(xml):
        tag = m.group(0)
        if tag.startswith('<hp:p ') or tag == '<hp:p>':
            paras.append(m.start())
        elif tag == '</hp:p>':
            if paras:
                pend[paras.pop()] = m.end()
        elif tag.startswith('<hp:run'):
            if not tag.endswith('/>'):
                cp = re.search(r'charPrIDRef="(\d+)"', tag)
                runs.append(cp.group(1) if cp else None)
        elif tag == '</hp:run>':
            if runs:
                runs.pop()
        else:
            out.append({'start': m.start(), 'end': m.end(), 'inner': m.group(1),
                        'char_pr': runs[-1] if runs else None,
                        'para': paras[-1] if paras else None})
    for n in out:
        n['para'] = (n['para'], pend.get(n['para'], len(xml)))
    return out


def _own_lineseg(xml, para):
    """그 문단 «자신»의 줄배치 구간 (안쪽 표 문단 것이 아니라).
    문단 자식 순서가 「글자묶음들 → 줄배치」 라서 구간 안 마지막 것이 자기 것이다."""
    a, b = para
    i = xml.rfind('<hp:linesegarray>', a, b)
    if i < 0:
        return None
    j = xml.find('</hp:linesegarray>', i, b)
    return (i, j + len('</hp:linesegarray>')) if j >= 0 else None


def _split_text(inner):
    """조각 안쪽을 [글자, 태그, 글자 …] 로 나눈다 (<hp:tab/>·<hp:lineBreak/> 같은 자식이 섞인다)."""
    return re.split(r'(<[^>]+>)', inner)


def _apply(xml, edits):
    """겹치지 않는 (시작, 끝, 새 글자) 들을 뒤에서부터 끼운다."""
    for a, b, new in sorted(edits, key=lambda e: e[0], reverse=True):
        xml = xml[:a] + new + xml[b:]
    return xml


def para_texts(xml):
    """{문단 시작: 그 문단이 «직접» 가진 글자 (이스케이프된 그대로)} — 옛 글자 잔존 검사용.
    한 글자가 서식 경계로 조각나 있어도 문단 단위로 이어 붙여 본다."""
    out = {}
    for n in text_nodes(xml):
        plain = ''.join(x for x in _split_text(n['inner']) if not x.startswith('<'))
        out[n['para'][0]] = out.get(n['para'][0], '') + plain
    return out


def replace_map(xml, mapping):
    """여러 글자를 한 번에 바꾸고 {찾을글자: 바뀐 건수} 를 돌려준다.

    replace_text 와 다른 점 셋:
      · 바뀐 문단의 줄배치를 **그 자리에서** 비운다(함정 ① — 긴 값이 한 줄로 넘친다)
      · `&` `<` 가 든 찾을 글자도 맞는다(파일 안 글자는 이스케이프돼 있다)
      · 태그 사이 글자만 본다 — <hp:tab/> 같은 자식 태그 속성은 안 건드린다

    🔴 긴 것부터 바꾼다 — 짧은 키가 먼저 바뀌면 그것을 품은 긴 키가 0건이 된다.
    🔴 한컴 「모두 바꾸기(AllReplace)」 를 쓰지 말 것 — 바꾼 자리의 글자 서식(빨간 날짜 등)이 사라진다.
    """
    keys = sorted(mapping, key=len, reverse=True)
    counts = {k: 0 for k in keys}
    edits, touched = [], set()
    for n in text_nodes(xml):
        parts = _split_text(n['inner'])
        changed = False
        for i, piece in enumerate(parts):
            if piece.startswith('<'):
                continue
            for k in keys:
                ek = escape(k)
                c = piece.count(ek)
                if c:
                    counts[k] += c
                    piece = piece.replace(ek, escape(mapping[k]))
                    changed = True
            parts[i] = piece
        if changed:
            edits.append((n['start'], n['end'], '<hp:t>%s</hp:t>' % ''.join(parts)))
            touched.add(n['para'])
    for para in touched:
        ls = _own_lineseg(xml, para)
        if ls:
            edits.append((ls[0], ls[1], '<hp:linesegarray/>'))
    return _apply(xml, edits), counts


# 날짜 한 개 — 2026.08.05 · 2026. 08. 05. · 2026년 10월 21일 · 2026 년 10 월 21 일 · 2026.  10  .  22  .
_D = r'20\d{2}\s*(?:\.|년)\s*\d{1,2}\s*(?:\.|월)\s*\d{1,2}(?:\s*(?:\.|일)(?!\d))?'
# 기간까지 한 덩어리로 — 「~2026.08.05」 · 「… ~ 2026.10.20」 · 「…~09.29」 · 「…~20」
DATE_RE = (r'(?:~\s*)?' + _D +
           r'(?:\s*~\s*(?:' + _D +
           r'|\d{1,2}\s*(?:\.|월)\s*\d{1,2}(?:\s*(?:\.|일)(?!\d))?|\d{1,2}(?!\d)))?')


def char_color(header_xml, cid):
    m = re.search(r'<hh:charPr id="%s"[^>]*?textColor="([^"]+)"' % re.escape(str(cid)),
                  header_xml)
    return m.group(1).upper() if m else None


def clone_char_pr(header_xml, base_id, color):
    """서식 base_id 를 그대로 복제하되 글자색만 color 로 바꾼 새 서식을 만든다.
    (새 header, 새 번호) 를 돌려준다.

    🔴 「그 양식에 있는 아무 빨간 서식」 을 쓰지 말 것 — 크기·글꼴·자간이 달라 그 날짜만
    커지거나 줄이 밀린다. 바로 그 글자의 서식을 복제해 색만 바꾼다.
    """
    m = re.search(r'<hh:charPr id="%s"[^>]*>.*?</hh:charPr>' % re.escape(str(base_id)),
                  header_xml, re.S)
    if not m:
        raise KeyError('header 에 charPr %s 가 없다' % base_id)
    new_id = max(int(x) for x in re.findall(r'<hh:charPr id="(\d+)"', header_xml)) + 1
    node = re.sub(r'^<hh:charPr id="\d+"', '<hh:charPr id="%d"' % new_id, m.group(0))
    node = re.sub(r'textColor="[^"]*"', 'textColor="%s"' % color, node, count=1)
    end = header_xml.find('</hh:charProperties>')
    if end < 0:
        raise ValueError('header 에 charProperties 가 없다')
    header_xml = header_xml[:end] + node + header_xml[end:]
    header_xml = re.sub(r'(<hh:charProperties itemCnt=")(\d+)(")',
                        lambda mm: '%s%d%s' % (mm.group(1), int(mm.group(2)) + 1, mm.group(3)),
                        header_xml, count=1)
    return header_xml, str(new_id)


def color_matches(xml, header_xml, pattern, color='#DC0000', clone_cache=None):
    """pattern(정규식)에 맞는 글자만 떼어 color 로 칠한다.
    (xml, header, 칠한 글자 목록, 이미 그 색이던 글자 목록) 을 돌려준다.

    글자묶음을 「앞 / 맞은 글자 / 뒤」 로 나눈다 — 앞뒤는 원래 서식 그대로다.
    글자가 그대로라 줄배치는 비우지 않는다.
    여러 구역(section)을 칠할 때는 clone_cache 를 넘겨 같은 서식을 두 번 복제하지 않게 한다.

    🔴 한컴 「찾기」 를 되풀이하는 방식은 쓰지 말 것 — 같은 자리를 다시 찾으며 멈췄다(10/22 실측).
    """
    color = color.upper()
    clone_cache = {} if clone_cache is None else clone_cache
    rx = re.compile(pattern)
    hit, already, edits = [], [], []
    for n in text_nodes(xml):
        base = n['char_pr']
        parts = _split_text(n['inner'])
        texts = [p for p in parts if not p.startswith('<')]
        if base is None or not any(rx.search(p) for p in texts):
            continue
        if char_color(header_xml, base) == color:
            already += [m.group(0) for p in texts for m in rx.finditer(p)]
            continue
        if base not in clone_cache:
            header_xml, clone_cache[base] = clone_char_pr(header_xml, base, color)
        red = clone_cache[base]
        out, buf = [], ''
        for p in parts:
            if p.startswith('<'):
                buf += p
                continue
            pos = 0
            for m in rx.finditer(p):
                if not m.group(0).strip():
                    continue
                buf += p[pos:m.start()]
                out.append('<hp:t>%s</hp:t></hp:run><hp:run charPrIDRef="%s"><hp:t>%s</hp:t>'
                           '</hp:run><hp:run charPrIDRef="%s">' % (buf, red, m.group(0), base))
                hit.append(m.group(0))
                buf = ''
                pos = m.end()
            buf += p[pos:]
        out.append('<hp:t>%s</hp:t>' % buf)
        edits.append((n['start'], n['end'], ''.join(out)))
    return _apply(xml, edits), header_xml, hit, already


# ────────────────────────────────────────────────────────────
# 그림 · 도장 · 표 나누기 — 공통 재료
# ────────────────────────────────────────────────────────────

def para_spans(xml):
    """[(시작, 끝)] — 문서의 모든 문단(안쪽 표 문단 포함)."""
    out, st = [], []
    for m in re.finditer(r'<hp:p\b[^>]*>|</hp:p>', xml):
        if m.group(0) == '</hp:p>':
            if st:
                out.append((st.pop(), m.end()))
        else:
            st.append(m.start())
    return out


def para_of(spans, pos):
    """pos 를 «직접» 담은 가장 안쪽 문단."""
    best = None
    for a, b in spans:
        if a <= pos < b and (best is None or a > best[0]):
            best = (a, b)
    return best


def pic_nodes(xml):
    """[{start, end, name, para}] — 그림(<hp:pic>) 하나마다."""
    spans = para_spans(xml)
    out = []
    for m in re.finditer(r'<hp:pic\b.*?</hp:pic>', xml, re.S):
        nm = re.search(r'원본 그림의 이름: ([^<]*)</hp:shapeComment>', m.group(0))
        out.append({'start': m.start(), 'end': m.end(),
                    'name': nm.group(1).strip() if nm else '',
                    'para': para_of(spans, m.start())})
    return out


def find_text(xml, text):
    """text 가 든 글자 조각들 [(node, 조각 안 위치)] — 문서 순서."""
    et = escape(text)
    out = []
    for n in text_nodes(xml):
        i = n['inner'].find(et)
        while i >= 0:
            out.append((n, i))
            i = n['inner'].find(et, i + 1)
    return out


def image_size(path):
    """(가로 px, 세로 px) — PNG/JPEG 머리만 읽는다(Pillow 없이)."""
    import struct
    with open(path, 'rb') as f:
        head = f.read(26)
        if head[:8] == b'\x89PNG\r\n\x1a\n':
            return struct.unpack('>II', head[16:24])
        if head[:2] != b'\xff\xd8':
            raise ValueError('PNG/JPEG 만 됩니다: %s' % path)
        f.seek(2)
        while True:
            b = f.read(1)
            while b and b != b'\xff':
                b = f.read(1)
            while b == b'\xff':
                b = f.read(1)
            if not b:
                raise ValueError('JPEG 크기를 못 읽었다: %s' % path)
            mk = b[0]
            ln = struct.unpack('>H', f.read(2))[0]
            if mk in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                f.read(1)
                h, w = struct.unpack('>HH', f.read(4))
                return w, h
            f.seek(ln - 2, 1)


def next_ids(hpf, *xmls):
    """새 그림·표에 쓸 번호들 — {image: 다음 image 번호, z: 다음 zOrder, obj: 다음 개체 id}."""
    imgs = [int(x) for x in re.findall(r'id="image(\d+)"', hpf)]
    zs, objs = [0], [0]
    for x in xmls:
        zs += [int(v) for v in re.findall(r'zOrder="(\d+)"', x)]
        objs += [int(v) for v in re.findall(r'<hp:(?:tbl|pic)\b[^>]*?\bid="(\d+)"', x)]
    return {'image': max(imgs + [0]) + 1, 'z': max(zs) + 1, 'obj': max(objs + [1900000000]) + 1}


def add_image(hpf, n, path):
    """그림 파일 하나를 패키지에 등록한다. (hpf, image id, zip 안 경로)."""
    ext = os.path.splitext(path)[1].lower().lstrip('.')
    ext = {'jpeg': 'jpg'}.get(ext, ext)
    if ext not in ('jpg', 'png', 'bmp', 'gif'):
        raise ValueError('그림은 jpg/png/bmp/gif: %s' % path)
    iid = 'image%d' % n
    arc = 'BinData/%s.%s' % (iid, ext)
    return register_image(hpf, iid, arc, 'image/%s' % ext), iid, arc


def cell_box(xml, row, col, occurrence=0):
    """칸의 (폭, 높이, 안쪽 여백 좌, 우) — HWPUNIT."""
    _, _, _, a, b = _span_of(xml, row, col, occurrence)
    tail = xml[b:xml.find('</hp:tc>', b)]
    sz = re.search(r'<hp:cellSz width="(\d+)" height="(\d+)"', tail)
    mg = re.search(r'<hp:cellMargin left="(\d+)" right="(\d+)"', tail)
    if not sz:
        raise ValueError('(r%d,c%d) 칸 크기를 못 찾았다' % (row, col))
    return (int(sz.group(1)), int(sz.group(2)),
            int(mg.group(1)) if mg else 0, int(mg.group(2)) if mg else 0)


def cell_formats(xml, row, col, occurrence=0):
    """그 칸 첫 문단의 (문단 서식, 글자 서식) 번호 — 새 문단을 그 칸 모양 그대로 만들 때."""
    _, _, _, a, b = _span_of(xml, row, col, occurrence)
    seg = xml[a:b]
    pp = re.search(r'<hp:p\b[^>]*paraPrIDRef="(\d+)"', seg)
    cp = re.search(r'<hp:run charPrIDRef="(\d+)"', seg)
    return (pp.group(1) if pp else '0'), (cp.group(1) if cp else '0')


# ────────────────────────────────────────────────────────────
# 표 나누기
# ────────────────────────────────────────────────────────────

def tables(xml):
    """[(시작, 끝)] — 모든 표(안쪽 표 포함). 짝을 깊이로 맞춘다."""
    out, st = [], []
    for m in re.finditer(r'<hp:tbl\b|</hp:tbl>', xml):
        if m.group(0) == '</hp:tbl>':
            if st:
                out.append((st.pop(), m.end()))
        else:
            st.append(m.start())
    return sorted(out)


def table_rows(tbl):
    """표 하나의 «자기» 행들 [(시작, 끝)] — 칸 안 표의 행은 빼고."""
    rows, depth, cur = [], 0, None
    for m in re.finditer(r'<hp:tbl\b|</hp:tbl>|<hp:tr>|</hp:tr>', tbl):
        t = m.group(0)
        if t.startswith('<hp:tbl'):
            depth += 1
        elif t == '</hp:tbl>':
            depth -= 1
        elif depth == 1 and t == '<hp:tr>':
            cur = m.start()
        elif depth == 1 and t == '</hp:tr>':
            rows.append((cur, m.end()))
    return rows


def _row_cells(row_xml):
    """그 행의 «자기» 칸 (rowAddr, rowSpan, 높이) 들 — 칸 안 표는 건너뛴다."""
    out, depth = [], 0
    for m in re.finditer(r'<hp:tbl\b|</hp:tbl>|<hp:cellAddr colAddr="\d+" rowAddr="(\d+)"/>'
                         r'<hp:cellSpan colSpan="\d+" rowSpan="(\d+)"/><hp:cellSz width="\d+" height="(\d+)"',
                         row_xml):
        t = m.group(0)
        if t.startswith('<hp:tbl'):
            depth += 1
        elif t == '</hp:tbl>':
            depth -= 1
        elif depth == 0:
            out.append((int(m.group(1)), int(m.group(2)), int(m.group(3))))
    return out


def _renumber_rows(row_xml, delta):
    """행 안 «자기» 칸들의 rowAddr 를 delta 만큼 옮긴다."""
    parts, depth, last = [], 0, 0
    for m in re.finditer(r'<hp:tbl\b|</hp:tbl>|<hp:cellAddr colAddr="(\d+)" rowAddr="(\d+)"/>', row_xml):
        t = m.group(0)
        if t.startswith('<hp:tbl'):
            depth += 1
        elif t == '</hp:tbl>':
            depth -= 1
        elif depth == 0:
            parts.append(row_xml[last:m.start()])
            parts.append('<hp:cellAddr colAddr="%s" rowAddr="%d"/>' % (m.group(1), int(m.group(2)) + delta))
            last = m.end()
    parts.append(row_xml[last:])
    return ''.join(parts)


def split_table(xml, tbl_span, rows_per, header=1, page_break=False, start_id=None):
    """표 하나를 rows_per 줄씩 여러 표로 나눈다(머리 header 줄은 표마다 되풀이).

    🔴 쪽을 넘는 「글자처럼 취급」 표는 다음 쪽으로 못 넘어가 **아래가 잘린다**(10/22 실측).
       `pageBreak="TABLE"` 전환은 1×1 표에서 **본문이 사라졌다** — 나누는 것이 정답이다.
    🔴 세로로 합쳐진 칸(rowSpan)이 자르는 자리를 넘으면 멈춘다 — 잘라서 만들면 칸이 깨진다.

    나눈 표는 원래 표를 담은 문단 «바로 뒤»에 새 문단으로 하나씩 붙는다.
    """
    a, b = tbl_span
    tbl = xml[a:b]
    rows = table_rows(tbl)
    if len(rows) <= header + rows_per:
        raise ValueError('행 %d개 — 나눌 필요가 없다(머리 %d + %d줄)' % (len(rows), header, rows_per))
    cells = [_row_cells(tbl[r0:r1]) for r0, r1 in rows]
    bounds = list(range(header, len(rows), rows_per))
    for i, cs in enumerate(cells):
        for addr, span, _h in cs:
            last = addr + span - 1
            for cut in bounds[1:] + ([header] if header else []):
                if addr < cut <= last:
                    raise ValueError('%d행 칸이 %d행까지 합쳐져 있어 %d행에서 자를 수 없다' % (addr, last, cut))
    head_xml = ''.join(tbl[r0:r1] for r0, r1 in rows[:header])
    head_h = sum(max(h for _, _, h in cs) for cs in cells[:header]) if header else 0
    pre = tbl[:rows[0][0]]
    post = tbl[rows[-1][1]:]
    nid = start_id or 1900000000
    pieces = []
    for k, s in enumerate(bounds):
        chunk = rows[s:s + rows_per]
        body = ''.join(_renumber_rows(tbl[r0:r1], header - s) for r0, r1 in chunk)
        h = head_h + sum(max(hh for _, _, hh in cells[s + j]) for j in range(len(chunk)))
        t = pre
        t = re.sub(r'rowCnt="\d+"', 'rowCnt="%d"' % (header + len(chunk)), t, count=1)
        t = re.sub(r'(<hp:sz width="\d+" widthRelTo="\w+" height=")\d+', lambda m: m.group(1) + str(h), t, count=1)
        if k:
            t = re.sub(r'^<hp:tbl id="\d+"', '<hp:tbl id="%d"' % (nid + k), t, count=1)
        pieces.append(t + head_xml + body + post)
    # 원래 표 자리에 첫 조각, 나머지는 담은 문단 뒤에 새 문단으로
    pspan = para_of(para_spans(xml), a)
    if not pspan:
        raise ValueError('표를 담은 문단을 못 찾았다')
    pa, pb = pspan
    popen = re.match(r'<hp:p\b[^>]*>', xml[pa:]).group(0)
    run_open = xml[:a][xml[:a].rfind('<hp:run'):]
    run_open = re.match(r'<hp:run\b[^>]*>', run_open).group(0)
    extra = ''
    for t in pieces[1:]:
        po = re.sub(r'\bid="\d+"', 'id="0"', popen, count=1)
        po = re.sub(r'pageBreak="\d"', 'pageBreak="%d"' % (1 if page_break else 0), po, count=1)
        extra += '%s%s%s</hp:run><hp:linesegarray/></hp:p>' % (po, run_open, t)
    out = xml[:a] + pieces[0] + xml[b:pb] + extra + xml[pb:]
    ls = _own_lineseg(out, (pa, pb + len(pieces[0]) - (b - a)))
    if ls:
        out = out[:ls[0]] + '<hp:linesegarray/>' + out[ls[1]:]
    return out, len(pieces)


# ────────────────────────────────────────────────────────────
# 그림 넣기 · 도장 · 그림 지우기
# ────────────────────────────────────────────────────────────

def pics_in_cell(xml, hpf, row, col, images, cols=1, captions=None, width=None,
                 occurrence=0, ids=None):
    """칸 하나를 그림 표들로 채운다 — cols 장씩 한 줄(1행 cols열 표), 줄마다 아래에 설명 한 줄.

    images  : 로컬 그림 경로들 (원본 해상도 그대로 — 표 칸 크기가 표시 크기를 정한다, 함정 ⑩)
    width   : 그림 한 장 폭(HWPUNIT). 없으면 칸 폭을 cols 로 나눈다
    돌려줌  : (xml, hpf, {zip 안 경로: 로컬 경로}, 넣은 수)

    🔴 칸 내용을 통째로 갈아끼운다 — 옛 그림을 먼저 걷어내므로 함정 ⑪(같은 ID 를 지움)이 안 난다.
    🔴 표는 «글자처럼 취급»(흐르는 표)이다. 떠 있는 표로 만들면 칸 높이를 안 밀고 겹친다.
    """
    if not images:
        raise ValueError('그림이 없다')
    if captions and len(captions) != len(images):
        raise ValueError('설명 %d개 ≠ 그림 %d개' % (len(captions), len(images)))
    cw, _ch, ml, mr = cell_box(xml, row, col, occurrence)
    para_pr, char_pr = cell_formats(xml, row, col, occurrence)
    w = width or (cw - ml - mr - int(2 * MM)) // cols
    if w <= 0:
        raise ValueError('칸이 너무 좁다')
    ids = ids or next_ids(hpf, xml)
    adds, inner = {}, []
    for k in range(0, len(images), cols):
        items = []
        for path in images[k:k + cols]:
            iw, ih = image_size(path)
            hpf, iid, arc = add_image(hpf, ids['image'], path)
            ids['image'] += 1
            adds[arc] = path
            h = int(w * ih / iw)
            items.append((pic_node(iid, w, h, w, h, 1, 'PARA', 'COLUMN', z=ids['z'],
                                   name=os.path.basename(path)), w, h))
            ids['z'] += 1
        tbl = pic_table(items, ids['obj'], z=ids['z'], char_pr=char_pr, para_pr=para_pr)
        ids['obj'] += 1
        ids['z'] += 1
        inner.append('<hp:p id="0" paraPrIDRef="%s" styleIDRef="0" pageBreak="0" columnBreak="0" '
                     'merged="0"><hp:run charPrIDRef="%s">%s</hp:run><hp:linesegarray/></hp:p>'
                     % (para_pr, char_pr, tbl))
        if captions:
            inner.append(make_para('    /    '.join(captions[k:k + cols]), para_pr, char_pr))
    xml = set_cell_content(xml, row, col, ''.join(inner), occurrence)
    return xml, hpf, adds, len(images)


def stamp_node(iid, size, x, y, z, name):
    """도장 — 글 앞에 떠 있는 그림(글을 밀지 않는다). x·y = 종이 왼쪽 위 기준 HWPUNIT."""
    node = pic_node(iid, size, size, size, size, 0, 'PAPER', 'PAPER',
                    vert_off=y, horz_off=x, z=z, name=name)
    return node.replace('textWrap="TOP_AND_BOTTOM"', 'textWrap="IN_FRONT_OF_TEXT"', 1)


def insert_after_text(xml, node, offset, text, inline_xml):
    """글자 조각 node 안 offset 위치의 text 바로 뒤에 inline_xml(그림 등)을 끼운다.

    🔴 그 «문단의 글자묶음 뒤»에 직접 붙인다 — 문서 마지막 문단에 매달면 빈 쪽이 생기고(함정 ⑦),
       칸 끝에 매달면 다음 쪽으로 밀린다. 글자묶음을 「…(인)」 / 그림 / 「뒤 글자」 로 나눈다.
    """
    cut = offset + len(escape(text))
    inner = node['inner']
    base = node['char_pr'] or '0'
    new = ('<hp:t>%s</hp:t></hp:run><hp:run charPrIDRef="%s">%s</hp:run>'
           '<hp:run charPrIDRef="%s"><hp:t>%s</hp:t>' % (inner[:cut], base, inline_xml, base, inner[cut:]))
    return xml[:node['start']] + new + xml[node['end']:]


def delete_pics(xml, near, name=None):
    """near 글자가 든 문단의 그림을 지운다(name 을 주면 그 이름만). (xml, 지운 이름들).

    🔴 «몇 번째 그림»으로 지우지 말 것 — 문서 안 그림 순서는 보이는 순서와 다르다
       (10/22 실측: 순서로 짚어 지웠더니 엉뚱한 도장이 지워졌다).
    """
    paras = {n['para'] for n, _ in find_text(xml, near)}
    if not paras:
        raise LookupError('그 글자가 없다: %r' % near)
    gone, edits = [], []
    for p in pic_nodes(xml):
        if p['para'] in paras and (name is None or p['name'] == name):
            gone.append(p['name'])
            edits.append((p['start'], p['end'], ''))
    xml = _apply(xml, edits)
    xml = re.sub(r'<hp:run charPrIDRef="(\d+)"></hp:run>', r'<hp:run charPrIDRef="\1"/>', xml)
    return xml, gone


# ────────────────────────────────────────────────────────────
# 여백 · 저장
# ────────────────────────────────────────────────────────────

def get_margins(xml):
    """{top, bottom, left, right, header, footer} — 단위 mm."""
    m = re.search(r'<hp:margin([^>]*)/>', xml)
    if not m:
        return {}
    return {k: int(v) / MM for k, v in re.findall(r'(\w+)="(\d+)"', m.group(1))}


def set_margin(xml, which, mm_value):
    """여백 한 변을 mm 로 지정한다 (도장이 쪽을 밀 때 아래 여백을 줄이는 등)."""
    return re.sub(r'(<hp:margin[^>]*?)%s="\d+"' % which,
                  lambda m: '%s%s="%d"' % (m.group(1), which, round(mm_value * MM)),
                  xml, count=1)


MARGIN_KEYS = ('top', 'bottom', 'left', 'right', 'header', 'footer')


def set_margins(xml, **mm):
    """여백 여러 변을 mm **명시값**으로 지정한다. 모르는 변 이름이면 멈춘다.

    🔴 한컴 PageSetup 으로 고치지 말 것 — 값이 «현재값 기준»으로 읽히는 자리가 있어
    준 값과 다른 여백이 됐다(상대값 함정). XML 에 숫자를 직접 쓴다.
    """
    for k, v in mm.items():
        if k not in MARGIN_KEYS:
            raise KeyError('여백 이름은 %s 중 하나: %s' % ('/'.join(MARGIN_KEYS), k))
        if v is None:
            continue
        if v < 0:
            raise ValueError('여백은 0 이상: %s=%s' % (k, v))
        if not re.search(r'<hp:margin[^>]*\b%s="\d+"' % k, xml):
            raise ValueError('이 구역에 여백 정보(%s)가 없다' % k)
        xml = set_margin(xml, k, v)
    return xml


def register_image(hpf, img_id, href, media='image/jpg'):
    """content.hpf 목록에 그림 하나를 등록한다. 그림 등록은 여기 한 곳뿐이다."""
    if 'id="%s"' % img_id in hpf:
        return hpf
    item = '<opf:item id="%s" href="%s" media-type="%s" isEmbeded="1"/>' % (img_id, href, media)
    return hpf.replace('<opf:manifest>', '<opf:manifest>' + item, 1)


def check_wellformed(**docs):
    """저장 전 XML 이 깨지지 않았는지 본다.

    🔴 반드시 부를 것. 깨진 채 넘기면 한글이 **아무 말 없이 빈 문서를 연다**
    (실측: Open 이 False 를 주고 1쪽짜리 빈 문서가 열렸다. 예외도 경고도 없었다).
    """
    from xml.etree import ElementTree as ET
    for name, doc in docs.items():
        try:
            ET.fromstring(doc)
        except Exception as e:
            raise AssertionError('%s XML 이 깨졌다: %s' % (name, e))
    return True


def save(src_hwpx, dst_hwpx, replaced=None, add_files=None):
    """편집한 XML 과 새 그림을 넣어 새 hwpx 로 저장한다.

    replaced : {zip 안 경로: 새 내용(str 또는 bytes)}
    add_files: {zip 안 경로: 로컬 파일 경로}
    """
    replaced = {k: (v.encode('utf-8') if isinstance(v, str) else v)
                for k, v in (replaced or {}).items()}
    add_files = add_files or {}
    zin = zipfile.ZipFile(src_hwpx)
    names = zin.namelist()
    if os.path.exists(dst_hwpx):
        os.remove(dst_hwpx)
    zout = zipfile.ZipFile(dst_hwpx, 'w', zipfile.ZIP_DEFLATED)
    # mimetype 은 맨 앞 + 압축하지 않음 (zip 규약)
    if 'mimetype' in names:
        zout.writestr(zipfile.ZipInfo('mimetype'), zin.read('mimetype'), zipfile.ZIP_STORED)
    for n in names:
        if n == 'mimetype':
            continue
        zout.writestr(n, replaced.get(n, zin.read(n)))
    for arc, local in add_files.items():
        with open(local, 'rb') as f:
            zout.writestr(arc, f.read())
    zout.close()
    zin.close()
    return dst_hwpx
