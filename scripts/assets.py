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

# Installer icon: the app mark with a small download badge, drawn at 4x for smooth edges.
setup = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
draw = ImageDraw.Draw(setup)
draw.rounded_rectangle((0, 0, 1023, 1023), radius=232, fill='#293126')
for box in [(200, 388, 308, 664), (392, 256, 500, 752), (584, 328, 692, 704)]:
    draw.rounded_rectangle(box, radius=54, fill='#d9edaa')
draw.ellipse((600, 600, 968, 968), fill='#dcf78b', outline='#293126', width=36)
draw.line((784, 690, 784, 850), fill='#293126', width=44)
draw.line((718, 790, 784, 856, 850, 790), fill='#293126', width=44, joint='curve')
setup = setup.resize((256, 256), Image.LANCZOS)
setup.save(root.parent / 'installer' / 'still-setup.png')
setup.save(root.parent / 'installer' / 'still-setup.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('Installer icon generated.')
