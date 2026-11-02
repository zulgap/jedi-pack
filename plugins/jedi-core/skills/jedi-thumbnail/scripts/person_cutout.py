# 사람 누끼 + 흰 테두리 — 썸네일 스킬 전부가 쓰는 공용 도구 (결정론 · LLM 0)
#
# 사용:
#   python -X utf8 person_cutout.py --image <사진.png> <출력.png> [--crop x0,y0,x1,y1] [--outline 0.01]
#   python -X utf8 person_cutout.py --video <영상> --t <초> <출력.png> --crop x0,y0,x1,y1 [--outline 0.01]
#   옵션: --fade-bottom 0.07 · --fade-right 0.05 · --fade-left 0 (가장자리를 서서히 지운다 · 화면 밖으로 잘린 몸을 자연스럽게)
#         --outline <비율>  흰 테두리 두께 = 누끼 높이 × 비율 (0 = 없음 · 값은 채널 파일이 정한다 · 0.005 ≈ 화면 높이 620 에서 3px)
#         --outline-color "#ffffff"
#         --enhance  얼굴 기본 보정 먼저(피부·반사광·노출·선명도 — 고객사 채널 확정본이 이 보정을 거쳤다)
#
# @AI:INTENT 누끼 도구가 스킬마다 흩어져 있었다(채널 스킬 하나의 누끼 파일을 다른 채널이 빌려 씀 · 모태는 크로마키 대안).
#   2026-11-02 결정 「누끼를 제대로 따는 도구를 정해서 · 사람 누끼를 따고 위에 테두리까지」 → 이 파일 하나로 모은다.
# @AI:CONSTRAINT 모델 = rembg «birefnet-portrait» 고정(첫 실행 때 973MB 를 스스로 받는다) + pymatting 가장자리 색 복원.
#   🔴 isnet-general-use 쓰지 말 것 — 의자가 같이 잘리고 경계가 계단처럼 깨졌다(고객사 채널 10/6 반려 2회 「깨져보여요」「픽셀로 짤린게보임」).
#   🔴 반투명 가장자리를 «잘라 내지» 말 것 — 상자 모양 얼룩이 남는다(고객사 채널 옛 방식). 알파는 그대로 두고 색만 복원한다.
# @AI:INTENT 테두리 두께는 «누끼 높이에 대한 비율»이다 — 화소로 박으면 나중에 얹을 때 크기를 바꾸는 순간 두께가 달라진다.
import sys, os, argparse, subprocess
import numpy as np


def _hex(c):
    c = c.lstrip('#')
    return tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))


def enhance_rgb(rgb):
    """얼굴 기본 보정(RGB uint8 → RGB uint8) — 피부(가장자리 보존 블러 38%) → 반사광 → 노출·S커브 → 색감 거의 그대로 → 선명도.
    @AI:CONSTRAINT 채널 스킬에 같은 보정식이 남아 있으면 그쪽 시험이 이 함수와 대조한다 — 한쪽만 고치면 썸네일 얼굴이 갈라진다."""
    import cv2
    crop = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    x = cv2.addWeighted(crop, 0.62, cv2.bilateralFilter(crop, 15, 40, 15), 0.38, 0).astype(np.float32) / 255
    lum = x.mean(axis=2, keepdims=True); x = np.where(lum > 0.78, x - (lum - 0.78) * 0.55, x)
    x = np.clip(x * 1.06 + 0.02, 0, 1); x = 0.5 + (x - 0.5) * 1.10; x[..., 2] *= 1.015; x[..., 0] *= 0.99
    out = (np.clip(x, 0, 1) * 255).astype(np.uint8)
    out = cv2.addWeighted(out, 1.35, cv2.GaussianBlur(out, (0, 0), 2.0), -0.35, 0)
    return cv2.cvtColor(out, cv2.COLOR_BGR2RGB)


def keep_largest(alpha, grow=6):
    """사람 한 덩어리만 남긴다 — 의자·소품처럼 떨어진 덩어리는 지운다(10/6 «의자 같이 잘림»)."""
    from scipy import ndimage
    m = alpha > 0.5
    lab, n = ndimage.label(m)
    if n == 0:
        return alpha * 0
    k = 1 + int(np.argmax(ndimage.sum(m, lab, range(1, n + 1))))
    return alpha * ndimage.binary_dilation(lab == k, iterations=grow)


def fade_edges(rgba, bottom=0.07, right=0.0, left=0.0):
    """가장자리에서 안쪽으로 불투명도를 0→1 로 — 화면 밖으로 잘린 몸이 칼로 자른 듯 보이지 않게."""
    H, W = rgba.shape[:2]
    a = rgba[:, :, 3].astype(np.float32)
    for frac, side in ((bottom, 'bottom'), (right, 'right'), (left, 'left')):
        f = int((H if side == 'bottom' else W) * frac)
        if f <= 0:
            continue
        ramp = np.arange(f, dtype=np.float32) / f
        if side == 'bottom':
            a[H - f:, :] *= ramp[::-1][:, None]
        elif side == 'right':
            a[:, W - f:] *= ramp[::-1][None, :]
        else:
            a[:, :f] *= ramp[None, :]
    rgba[:, :, 3] = np.clip(a, 0, 255).astype(np.uint8)
    return rgba


def add_outline(rgba, ratio, color=(255, 255, 255)):
    """사람 둘레에 테두리를 두른다. 두께 = 누끼 높이 × ratio. 그림이 잘리지 않게 그만큼 여백을 붙인다."""
    import cv2
    if ratio <= 0:
        return rgba
    H = rgba.shape[0]
    ow = max(1, int(round(H * ratio)))
    p = ow * 2
    rgba = np.pad(rgba, ((p, p), (p, p), (0, 0)))
    a = rgba[:, :, 3]
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ow * 2 + 1, ow * 2 + 1))
    ring = cv2.GaussianBlur(cv2.dilate(a, k), (0, 0), max(0.8, ow * 0.1)).astype(np.float32) / 255
    fa = a.astype(np.float32) / 255
    out_a = fa + ring * (1 - fa)                      # 사람 위에 테두리를 «뒤에서» 깐다
    col = np.array(color, dtype=np.float32)
    rgb = (rgba[:, :, :3].astype(np.float32) * fa[..., None] + col * (ring * (1 - fa))[..., None]) / np.maximum(out_a, 1e-6)[..., None]
    return np.dstack([np.clip(rgb, 0, 255).astype(np.uint8), (np.clip(out_a, 0, 1) * 255).astype(np.uint8)])


def trim(rgba):
    ys, xs = np.nonzero(rgba[:, :, 3] > 0)
    if len(ys) == 0:
        return rgba
    return rgba[ys.min():ys.max() + 1, xs.min():xs.max() + 1]


def cutout_rgb(rgb, mask_fn=None, fade=(0.07, 0.0, 0.0), outline=0.0, outline_color=(255, 255, 255)):
    """rgb(uint8 H×W×3) → 누끼 RGBA. mask_fn 은 시험용(모델 없이 가짜 마스크)."""
    if mask_fn is None:
        from rembg import remove, new_session
        from PIL import Image
        mask_fn = lambda x: np.array(remove(Image.fromarray(x), session=new_session('birefnet-portrait'), only_mask=True)).astype(np.float32) / 255
    al = keep_largest(mask_fn(rgb))
    try:
        from pymatting import estimate_foreground_ml   # 머리카락 둘레 흰 번짐 제거
        fg = np.clip(estimate_foreground_ml(rgb.astype(np.float64) / 255, al.astype(np.float64)), 0, 1)
    except ImportError:
        fg = rgb.astype(np.float64) / 255
    rgba = np.dstack([(fg * 255).astype(np.uint8), (np.clip(al, 0, 1) * 255).astype(np.uint8)])
    rgba = fade_edges(rgba, *fade)
    rgba = trim(rgba)
    return trim(add_outline(rgba, outline, outline_color))


def _read(path):
    import cv2
    # 🔴 cv2.imread 는 윈도 한글 경로를 못 읽고 None 을 준다(2026-10-06 실측) → 바이트로 읽어 decode
    im = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)
    if im is None:
        sys.exit(f'🔴 그림을 못 읽었다: {path}')
    return cv2.cvtColor(im, cv2.COLOR_BGR2RGB)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out')
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument('--image'); src.add_argument('--video')
    ap.add_argument('--t', type=float)
    ap.add_argument('--crop')
    ap.add_argument('--fade-bottom', type=float, default=0.07)
    ap.add_argument('--fade-right', type=float, default=0.0)
    ap.add_argument('--fade-left', type=float, default=0.0)
    ap.add_argument('--outline', type=float, default=0.0)
    ap.add_argument('--outline-color', default='#ffffff')
    ap.add_argument('--enhance', action='store_true', help='얼굴 기본 보정을 먼저 한다(고객사 채널 확정본 방식)')
    a = ap.parse_args()
    if a.video:
        if a.t is None:
            sys.exit('🔴 --video 에는 --t <초> 가 필요하다')
        raw = a.out[:-4] + '_원본.png'
        subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(a.t), '-i', a.video, '-frames:v', '1', '-y', raw], check=True)
        rgb = _read(raw)
    else:
        rgb = _read(a.image)
    if a.crop:
        x0, y0, x1, y1 = map(int, a.crop.split(','))
        rgb = rgb[y0:y1, x0:x1].copy()
    from PIL import Image
    if a.enhance:
        rgb = enhance_rgb(rgb)
        Image.fromarray(rgb).save(a.out[:-4] + '_보정.png')
    rgba = cutout_rgb(rgb, fade=(a.fade_bottom, a.fade_right, a.fade_left), outline=a.outline, outline_color=_hex(a.outline_color))
    Image.fromarray(rgba).save(a.out)
    print('ok', a.out, rgba.shape[1], 'x', rgba.shape[0], '· 테두리', a.outline)


if __name__ == '__main__':
    main()
