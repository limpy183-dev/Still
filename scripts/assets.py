from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1] / 'assets'
root.mkdir(exist_ok=True)
image = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((0, 0, 255, 255), radius=58, fill='#293126')
for box in [(65, 97, 92, 166), (113, 64, 140, 188), (161, 82, 188, 176)]:
    draw.rounded_rectangle(box, radius=13, fill='#d9edaa')
image.save(root / 'still.png')
image.save(root / 'still.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('Windows app and tray icons generated.')
