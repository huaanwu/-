#!/usr/bin/env python3
"""生成 Electron 用的 icon.ico, 输出到 www/public/icons/ (build-web 会同步到 www/icons/)"""
import os
from PIL import Image, ImageDraw

BG=(13,17,23,255); RED=(239,68,68,255); GOLD=(251,191,36,255); WHITE=(255,255,255,255)

def _rc(img, r):
    m=Image.new('L', img.size, 0); ImageDraw.Draw(m).rounded_rectangle([(0,0),img.size], radius=r, fill=255)
    o=Image.new('RGBA',img.size,(0,0,0,0)); o.paste(img, mask=m); return o

def _draw(d, s, ox=0, oy=0):
    fx0=s*0.20+ox; fy0=s*0.36+oy; fx1=s*0.80+ox; fy1=s*0.78+oy; fw=fx1-fx0; fh=fy1-fy0
    d.rounded_rectangle([fx0,fy0,fx1,fy1], radius=int(fw*0.18), fill=RED)
    nw=fw*0.40; nh=fh*0.28; nx0=fx0+(fw-nw)/2; ny0=fy1-nh; ny1=fy1+s*0.02
    d.rounded_rectangle([nx0,ny0,nx0+nw,ny1], radius=int(nw*0.30), fill=RED)
    nr=max(1,int(s*0.022)); ny=ny0+nh*0.55
    for xf in [0.30,0.65]:
        nx=nx0+nw*xf; d.ellipse([nx-nr,ny-nr,nx+nr,ny+nr], fill=BG)
    d.polygon([(fx0+fw*0.10,fy0+fh*0.10),(fx0-fw*0.02,fy0-fh*0.55),(fx0+fw*0.30,fy0-fh*0.02)], fill=GOLD)
    d.polygon([(fx0+fw*0.70,fy0-fh*0.02),(fx0+fw*1.02,fy0-fh*0.55),(fx0+fw*0.90,fy0+fh*0.10)], fill=GOLD)
    ew=fw*0.20; eh=fh*0.30
    d.ellipse([fx0+fw*0.04,fy0-eh*0.30,fx0+fw*0.04+ew,fy0+eh*0.70], fill=RED)
    d.ellipse([fx0+fw*0.76-ew,fy0-eh*0.30,fx0+fw*0.76,fy0+eh*0.70], fill=RED)
    er=max(2,int(s*0.025)); pr=max(1,int(s*0.014))
    for xf in [0.32,0.68]:
        ex=fx0+fw*xf; ey=fy0+fh*0.40
        d.ellipse([ex-er,ey-er,ex+er,ey+er], fill=WHITE)
        d.ellipse([ex-pr,ey-pr,ex+pr,ey+pr], fill=BG)

def _render(size):
    s=size; img=Image.new('RGBA',(s,s),BG); img=_rc(img,int(s*0.2237)); d=ImageDraw.Draw(img); _draw(d,s)
    a=s*0.18; ax=s*0.76; ay=s*0.14
    d.polygon([(ax,ay+a),(ax+a/2,ay),(ax+a,ay+a),(ax+a*0.70,ay+a),(ax+a/2,ay+a*0.36),(ax+a*0.30,ay+a)], fill=RED)
    return img

sizes=[16,32,48,64,128,256]
imgs=[]
for sz in sizes:
    img=_render(sz)
    if img.mode=='RGBA':
        bg=Image.new('RGB',img.size,BG[:3]); bg.paste(img, mask=img.split()[3]); img=bg
    imgs.append(img)

os.makedirs('www/public/icons', exist_ok=True)
out='www/public/icons/icon.ico'
imgs[0].save(out, format='ICO', sizes=[(sz,sz) for sz in sizes], append_images=imgs[1:])
print('OK', out, sizes)