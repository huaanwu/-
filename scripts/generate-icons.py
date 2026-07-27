#!/usr/bin/env python3
"""
StockMaster 图标生成器 v2 — 牛市头 (金融) 风格
- 圆角矩形背景 (#0d1117 GitHub dark)
- 中心: 简化牛头剪影 + K 线柱 + 涨箭头
- 主色: 涨红 #ef4444 / 涨金 #fbbf24 (牛角用金色) / 白
- 输出去向: 同 v1
"""
import os
from PIL import Image, ImageDraw

BG     = (13, 17, 23, 255)
RED    = (239, 68, 68, 255)
GOLD   = (251, 191, 36, 255)
WHITE  = (255, 255, 255, 255)
GRAY   = (107, 114, 128, 255)

OUT_PWA   = 'www/public/icons'
OUT_APP   = 'www/icons'
OUT_AND   = 'android/app/src/main/res'

AND_SIZES = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
FG_SIZES  = {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}


def _round_corners(img, radius):
    mask = Image.new('L', img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([(0, 0), img.size], radius=radius, fill=255)
    out = Image.new('RGBA', img.size, (0, 0, 0, 0))
    out.paste(img, mask=mask)
    return out


def _draw_bull_head(d, s, ox=0, oy=0):
    """画牛头 (简化剪影, 正面朝外, 角朝上方两侧)
    整体绘制区域: 占图 0.18-0.82 x 0.30-0.78
    ox/oy: 偏移, 默认 (0,0)
    """
    # 脸 (圆角矩形, 占图 60% 宽 × 45% 高, 居中略偏下)
    face_x0 = s * 0.20 + ox
    face_y0 = s * 0.36 + oy
    face_x1 = s * 0.80 + ox
    face_y1 = s * 0.78 + oy
    face_w = face_x1 - face_x0
    face_h = face_y1 - face_y0
    d.rounded_rectangle([face_x0, face_y0, face_x1, face_y1],
                         radius=int(face_w * 0.18), fill=RED)

    # 鼻梁 (底部中间凸出)
    nose_w = face_w * 0.40
    nose_h = face_h * 0.28
    nose_x0 = face_x0 + (face_w - nose_w) / 2
    nose_y0 = face_y1 - nose_h
    nose_x1 = nose_x0 + nose_w
    nose_y1 = face_y1 + s * 0.02
    d.rounded_rectangle([nose_x0, nose_y0, nose_x1, nose_y1],
                         radius=int(nose_w * 0.30), fill=RED)
    # 鼻孔 (两个小黑点, 在鼻梁下半部)
    nr = max(1, int(s * 0.022))
    nostril_y = nose_y0 + nose_h * 0.55
    for i, xfrac in enumerate([0.30, 0.65]):
        nx = nose_x0 + nose_w * xfrac
        d.ellipse([nx - nr, nostril_y - nr, nx + nr, nostril_y + nr], fill=BG)

    # 牛角 (金色, 两根朝上方两侧)
    # 左角
    d.polygon([
        (face_x0 + face_w * 0.10, face_y0 + face_h * 0.10),  # 角根左
        (face_x0 - face_w * 0.02, face_y0 - face_h * 0.55),  # 角尖左上
        (face_x0 + face_w * 0.30, face_y0 - face_h * 0.02),  # 角根右上
    ], fill=GOLD)
    # 右角
    d.polygon([
        (face_x0 + face_w * 0.70, face_y0 - face_h * 0.02),  # 角根左
        (face_x0 + face_w * 1.02, face_y0 - face_h * 0.55),  # 角尖右上
        (face_x0 + face_w * 0.90, face_y0 + face_h * 0.10),  # 角根右
    ], fill=GOLD)

    # 牛耳 (脸部上侧, 两边凸出)
    ear_w = face_w * 0.20
    ear_h = face_h * 0.30
    # 左耳
    d.ellipse([face_x0 + face_w * 0.04, face_y0 - ear_h * 0.30,
               face_x0 + face_w * 0.04 + ear_w, face_y0 + ear_h * 0.70],
              fill=RED)
    # 右耳
    d.ellipse([face_x0 + face_w * 0.76 - ear_w, face_y0 - ear_h * 0.30,
               face_x0 + face_w * 0.76, face_y0 + ear_h * 0.70],
              fill=RED)

    # 眼睛 (左右各一, 白色圆 + 黑眼仁)
    eye_r = max(2, int(s * 0.025))
    pupil_r = max(1, int(s * 0.014))
    for xfrac in [0.32, 0.68]:
        ex = face_x0 + face_w * xfrac
        ey = face_y0 + face_h * 0.40
        d.ellipse([ex - eye_r, ey - eye_r, ex + eye_r, ey + eye_r], fill=WHITE)
        d.ellipse([ex - pupil_r, ey - pupil_r, ex + pupil_r, ey + pupil_r], fill=BG)


def _render(size):
    s = size
    img = Image.new('RGBA', (s, s), BG)
    img = _round_corners(img, int(s * 0.2237))
    d = ImageDraw.Draw(img)

    # 牛头居中, 不偏移
    _draw_bull_head(d, s)

    # 右上角涨箭头 (红色, 实心三角)
    arr_size = s * 0.18
    arr_x = s * 0.76
    arr_y = s * 0.14
    arrow = [
        (arr_x, arr_y + arr_size),
        (arr_x + arr_size / 2, arr_y),
        (arr_x + arr_size, arr_y + arr_size),
        (arr_x + arr_size * 0.70, arr_y + arr_size),
        (arr_x + arr_size / 2, arr_y + arr_size * 0.36),
        (arr_x + arr_size * 0.30, arr_y + arr_size),
    ]
    d.polygon(arrow, fill=RED)

    return img


def _render_foreground(size):
    """Android adaptive foreground: 透明背景 + 中心元素 (只画牛头+箭头, 不画 K 线柱)
    系统会按 adaptive-icon 规范裁剪, 中心 50% 安全区"""
    s = size
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 居中画牛头, 缩放到中心 50% 安全区
    cx, cy = s / 2, s / 2
    safe = s * 0.50  # 安全区直径
    # 把 _draw_bull_head 的画法移植过来, 适配中心画法
    _draw_bull_head_centered(d, s, cx, cy, safe)

    # 右上箭头 (在安全区内的右上角)
    arr_size = s * 0.15
    arr_x = cx + safe * 0.30
    arr_y = cy - safe * 0.35
    arrow = [
        (arr_x, arr_y + arr_size),
        (arr_x + arr_size / 2, arr_y),
        (arr_x + arr_size, arr_y + arr_size),
        (arr_x + arr_size * 0.70, arr_y + arr_size),
        (arr_x + arr_size / 2, arr_y + arr_size * 0.36),
        (arr_x + arr_size * 0.30, arr_y + arr_size),
    ]
    d.polygon(arrow, fill=RED)

    return img


def _draw_bull_head_centered(d, s, cx, cy, safe):
    """中心化版本的牛头, 限制在 (cx, cy) ± safe/2 范围内"""
    # 脸
    fw = safe * 0.66
    fh = safe * 0.48
    fx0 = cx - fw / 2
    fy0 = cy - fh / 2 + safe * 0.06
    fx1 = fx0 + fw
    fy1 = fy0 + fh
    d.rounded_rectangle([fx0, fy0, fx1, fy1], radius=fw * 0.18, fill=RED)

    # 鼻梁
    nw = fw * 0.42
    nh = fh * 0.30
    nx0 = fx0 + (fw - nw) / 2
    ny0 = fy1 - nh
    nx1 = nx0 + nw
    ny1 = fy1 + safe * 0.02
    d.rounded_rectangle([nx0, ny0, nx1, ny1], radius=nw * 0.30, fill=RED)
    nr = max(1, int(safe * 0.030))
    nostril_y = ny0 + nh * 0.55
    for xfrac in [0.30, 0.65]:
        nx = nx0 + nw * xfrac
        d.ellipse([nx - nr, nostril_y - nr, nx + nr, nostril_y + nr], fill=BG)

    # 牛角
    d.polygon([
        (fx0 + fw * 0.10, fy0 + fh * 0.10),
        (fx0 - fw * 0.04, fy0 - fh * 0.55),
        (fx0 + fw * 0.30, fy0 - fh * 0.04),
    ], fill=GOLD)
    d.polygon([
        (fx0 + fw * 0.70, fy0 - fh * 0.04),
        (fx0 + fw * 1.04, fy0 - fh * 0.55),
        (fx0 + fw * 0.90, fy0 + fh * 0.10),
    ], fill=GOLD)

    # 牛耳
    ear_w = fw * 0.20
    ear_h = fh * 0.30
    d.ellipse([fx0 + fw * 0.04, fy0 - ear_h * 0.30,
               fx0 + fw * 0.04 + ear_w, fy0 + ear_h * 0.70], fill=RED)
    d.ellipse([fx0 + fw * 0.76 - ear_w, fy0 - ear_h * 0.30,
               fx0 + fw * 0.76, fy0 + ear_h * 0.70], fill=RED)

    # 眼睛
    eye_r = max(2, int(safe * 0.040))
    pupil_r = max(1, int(safe * 0.022))
    for xfrac in [0.32, 0.68]:
        ex = fx0 + fw * xfrac
        ey = fy0 + fh * 0.40
        d.ellipse([ex - eye_r, ey - eye_r, ex + eye_r, ey + eye_r], fill=WHITE)
        d.ellipse([ex - pupil_r, ey - pupil_r, ex + pupil_r, ey + pupil_r], fill=BG)


def _save(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if path.endswith('_foreground.png'):
        img.save(path, 'PNG', optimize=True)
    else:
        if img.mode == 'RGBA':
            rgb = Image.new('RGB', img.size, BG[:3])
            rgb.paste(img, mask=img.split()[3])
            rgb.save(path, 'PNG', optimize=True)
        else:
            img.save(path, 'PNG', optimize=True)
    print(f'  OK  {path}')


def _save_to_ico(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    sizes = [16, 32, 48, 64, 128, 256]
    images = []
    for sz in sizes:
        img = _render(sz)
        if img.mode == 'RGBA':
            bg = Image.new('RGB', img.size, BG[:3])
            bg.paste(img, mask=img.split()[3])
            img = bg
        images.append(img)
    images[0].save(path, format='ICO', sizes=[(sz, sz) for sz in sizes], append_images=images[1:])
    print(f'  OK  {path} ({sizes})')


def main():
    print('[Web PWA icons]:')
    _save(_render(192), f'{OUT_PWA}/icon-192.png')
    _save(_render(512), f'{OUT_PWA}/icon-512.png')

    print('[www/icons]:')
    _save(_render(192), f'{OUT_APP}/icon-192.png')
    _save(_render(512), f'{OUT_APP}/icon-512.png')

    print('[Android launcher]:')
    for dpi, size in AND_SIZES.items():
        _save(_render(size), f'{OUT_AND}/mipmap-{dpi}/ic_launcher.png')
        _save(_render(size), f'{OUT_AND}/mipmap-{dpi}/ic_launcher_round.png')

    print('[Android adaptive foreground]:')
    for dpi, size in FG_SIZES.items():
        _save(_render_foreground(size), f'{OUT_AND}/mipmap-{dpi}/ic_launcher_foreground.png')

    print('[Electron (Windows .ico source)]:')
    _save(_render(256), f'{OUT_APP}/icon-256.png')

    print('[Windows .ico]:')
    _save_to_ico(f'{OUT_APP}/icon.ico')

    print('\nDone')


if __name__ == '__main__':
    main()