from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch(headless=False, channel='msedge', args=['--no-proxy-server'])
    pg = b.new_page()
    msgs = []
    pg.on('console', lambda m: msgs.append(f'{m.type}: {m.text}'))
    pg.on('pageerror', lambda e: msgs.append(f'pageerror: {e}'))
    try:
        pg.goto('http://127.0.0.1:8767/bundle.html')
        pg.wait_for_selector('#log:has-text("SPIKE-")', timeout=60000)
    except Exception as e:
        print('等待超时/失败:', type(e).__name__)
    finally:
        print('--- 页面日志 ---')
        try:
            print(pg.inner_text('#log'))
        except Exception as e:
            print('读不到 #log:', e)
        print('--- 浏览器控制台/错误 ---')
        for m in msgs[:30]:
            print(m)
        pg.screenshot(path='scripts/pdf-spike-web/shot.png', full_page=True)
    b.close()
