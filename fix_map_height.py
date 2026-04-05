import re

with open('src/app/page.tsx', 'r') as f:
    content = f.read()

# Find the div directly wrapping MapWithNoSSR
# It should have flex-1 min-h-[0px] md:h-auto
# Change min-h-[0px] to min-h-[300px]

# The pattern for the div is:
# <div className={`flex-1 min-h-[0px] md:h-auto ${darkMode ? 'bg-zinc-900' : 'bg-gray-200'} border ${darkMode ? 'border-zinc-800' : 'border-gray-300'}} rounded-2xl overflow-hidden${editingRoute ? ' pointer-events-none select-none' : ''}`}>

old_html_pattern = (
    r'<div className={`flex-1 min-h-\[0px\] md:h-auto ${darkMode \? \'bg-zinc-900\' \: '
    r'\'bg-gray-200\'} border ${darkMode \? \'border-zinc-800\' \: \'border-gray-300\'}'
    r'} rounded-2xl overflow-hidden${editingRoute \? \' pointer-events-none select-none\' \: \'\'}`}>'
)

new_html_pattern = (
    r'<div className={`flex-1 min-h-\[300px\] md:h-auto ${darkMode \? \'bg-zinc-900\' \: '
    r'\'bg-gray-200\'} border ${darkMode \? \'border-zinc-800\' \: \'border-gray-300\'}'
    r'} rounded-2xl overflow-hidden${editingRoute \? \' pointer-events-none select-none\' \: \'\'}`}>'
)

content = re.sub(old_html_pattern, new_html_pattern, content, count=1)

with open('src/app/page.tsx', 'w') as f:
    f.write(content)

print("Changed map wrapper min-h-[0px] to min-h-[300px]")
