# 시험: 공용 누끼 도구(person_cutout.py) — 지난 반려·사고 하나에 시험 하나 (모델 없이 가짜 마스크로 돈다)
# 실행: python -X utf8 _test-person-cutout.py
import os, sys; os.environ['PYTHONUTF8'] = '1'; sys.stdout.reconfigure(encoding='utf-8'); sys.stderr.reconfigure(encoding='utf-8')
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from person_cutout import cutout_rgb, keep_largest

fails = []
def ok(c, m):
    print(('✅ ' if c else '❌ ') + m)
    if not c: fails.append(m)

H, W = 400, 300
yy, xx = np.mgrid[0:H, 0:W]
# 사람 = 타원(부드러운 가장자리) · 의자 = 떨어진 사각형
person = np.clip(1 - (((xx - 150) / 80) ** 2 + ((yy - 200) / 170) ** 2 - 1) * 8, 0, 1).astype(np.float32)
chair = np.zeros((H, W), np.float32); chair[300:390, 250:295] = 1
mask = np.maximum(person, chair)
rgb = np.full((H, W, 3), 255, np.uint8); rgb[person > 0] = (200, 30, 30)   # 흰 배경 위 빨간 사람

r0 = cutout_rgb(rgb, mask_fn=lambda x: mask, fade=(0, 0, 0), outline=0)
a0 = r0[:, :, 3]

# 1. 의자 같이 잘림(고객사 채널 10/6 반려) — 떨어진 덩어리는 지운다
ok(keep_largest(mask)[350, 270] == 0 and keep_largest(mask)[200, 150] > 0, '1 의자처럼 떨어진 덩어리는 지우고 사람만 남긴다')
# 2. 계단 경계(10/6 「픽셀로 짤린게보임」) — 가장자리 알파가 0/255 둘로만 나뉘지 않는다
ok(((a0 > 0) & (a0 < 255)).sum() > 50, '2 가장자리가 부드럽다(반투명 단계가 남는다)')
# 3. 상자 모양 얼룩(고객사 채널 옛 방식) — 결과 네 귀퉁이는 투명
ok(all(a0[y, x] == 0 for y, x in ((0, 0), (0, -1), (-1, 0), (-1, -1))), '3 네 귀퉁이가 투명하다(상자 모양이 안 남는다)')
# 4. 머리카락 흰 번짐 — 반투명 가장자리 색이 배경 흰색에 물들지 않는다(pymatting)
try:
    import pymatting  # noqa
    edge = (a0 > 40) & (a0 < 200)
    g = r0[:, :, 1][edge].mean() if edge.any() else 255
    ok(g < 120, f'4 가장자리 색이 흰 배경에 물들지 않는다(초록 성분 평균 {g:.0f} < 120)')
except ImportError:
    print('⏭ 4 pymatting 없음 — 건너뜀')
# 5. 테두리 빠짐(고객사 채널 10/12 재발) — outline 을 주면 사람 바깥에 흰 띠가 생긴다
r1 = cutout_rgb(rgb, mask_fn=lambda x: mask, fade=(0, 0, 0), outline=0.02)
ring = (r1[:, :, 3] > 200) & (r1[:, :, 0] > 240) & (r1[:, :, 1] > 240) & (r1[:, :, 2] > 240)
ok(ring.sum() > 500 and r1.shape[0] > r0.shape[0], '5 테두리를 주면 흰 띠가 둘러지고 그만큼 그림이 커진다')
# 6. 테두리 두께는 «누끼 높이 비율» — 두 배 큰 사진이면 띠도 약 두 배
big = np.kron(rgb, np.ones((2, 2, 1), np.uint8)); bigm = np.kron(mask, np.ones((2, 2), np.float32))
r2 = cutout_rgb(big, mask_fn=lambda x: bigm, fade=(0, 0, 0), outline=0.02)
grow1 = r1.shape[1] - r0.shape[1]
r0b = cutout_rgb(big, mask_fn=lambda x: bigm, fade=(0, 0, 0), outline=0)
grow2 = r2.shape[1] - r0b.shape[1]
ok(1.6 < grow2 / max(grow1, 1) < 2.4, f'6 두께가 크기에 비례한다(여백 {grow1} → {grow2})')
# 7. 아래 가장자리 서서히 지우기 — 맨 아래 줄이 맨 위 몸통보다 투명
r3 = cutout_rgb(rgb, mask_fn=lambda x: mask, fade=(0.2, 0, 0), outline=0)
ok(r3[-1, :, 3].max() < r3[r3.shape[0] // 2, :, 3].max(), '7 아래 가장자리를 서서히 지운다')
# 8. 얼굴 보정식 고정 — 고객사 채널 확정본(10/12)이 이 식으로 나갔다. 바꾸려면 사람 확인 뒤 지문을 새로 적을 것
import hashlib
from person_cutout import enhance_rgb, add_outline
rs = np.random.default_rng(1).integers(0, 255, (64, 48, 3), dtype=np.uint8)
ok(hashlib.sha1(enhance_rgb(rs).tobytes()).hexdigest()[:16] == 'ff49b7819d3257a1', '8 얼굴 보정식이 확정본과 같다(지문 고정)')
# 9. 화소로 두르기(px) — 최종 크기에서 두를 때 사방 여백 = 두께 × 2
px = add_outline(r0, 0, px=10)
ok(px.shape[0] == r0.shape[0] + 40 and px.shape[1] == r0.shape[1] + 40, '9 px 로 두르면 사방에 두께×2 여백')

print(f'\n{"전부 통과" if not fails else str(len(fails)) + "건 실패"}')
sys.exit(1 if fails else 0)
