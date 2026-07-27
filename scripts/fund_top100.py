"""基金排行 Top 100 输出 - 按近 3 年收益排序"""
import json

with open(r'D:\get\stock-master\fund_all.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

print('总基金数:', len(data))

def num(v):
    try: return float(str(v).replace('%',''))
    except: return float('-inf')

ranked = sorted(data, key=lambda x: num(x.get('近3年', -999)), reverse=True)

# 输出 Top 100
lines = []
lines.append('=== Top 100 按近 3 年收益排序 ===')
lines.append('代码       简称                           近1年     近3年     今年来    手续费')
lines.append('-' * 75)
for f in ranked[:100]:
    code = str(f.get('基金代码',''))
    name = f.get('基金简称','')[:26]
    n1 = f.get('近1年','')
    n3 = f.get('近3年','')
    ytd = f.get('今年来','')
    fee = f.get('手续费','')
    lines.append('{:<8} {:<28} {:>8} {:>8} {:>8} {:>7}'.format(code, name, str(n1), str(n3), str(ytd), str(fee)))

text = '\n'.join(lines)
# 写到文件 + 打印
with open(r'D:\get\stock-master\fund_top100.txt', 'w', encoding='utf-8') as f:
    f.write(text)
print(text)
print()
print('已保存到 D:\\get\\stock-master\\fund_top100.txt')
