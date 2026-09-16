"""Exercise the rebuilt UI against an isolated local-demo backend. No inference calls."""
import datetime
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = 'http://127.0.0.1:5195'
OUT = Path('evidence/browser/frontend-rebuild') / datetime.datetime.now(datetime.timezone.utc).strftime('qualification-%Y%m%dT%H%M%SZ')
OUT.mkdir(parents=True, exist_ok=False)
checks = []
contrast = []
errors = []
branch_id = None

CONTRAST = r'''() => {
 const rgb = s => { const n=s.match(/[\d.]+/g)?.map(Number);return n ? [n[0],n[1],n[2],n[3]??1] : [0,0,0,0]; };
 const mix=(a,b)=>[0,1,2].map(i=>a[i]*a[3]+b[i]*(1-a[3])).concat(1);
 const lum=c=>c.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
 const rows=[];const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;
 while(n=w.nextNode()) {
  if(!n.textContent.trim())continue;const e=n.parentElement;if(!e||!(e instanceof HTMLElement)||e.closest('script,style,option,[disabled]')||!e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))continue;
  const range=document.createRange();range.selectNodeContents(n);if(!range.getClientRects().length)continue;
  let chain=[];for(let x=e;x;x=x.parentElement)chain.unshift(x);let bg=[255,255,255,1];let opacity=1;
  for(const x of chain){const s=getComputedStyle(x);bg=mix(rgb(s.backgroundColor),bg);opacity*=Number(s.opacity);}
  const s=getComputedStyle(e);const fg=rgb(s.color);fg[3]*=opacity;const actual=mix(fg,bg);const a=lum(actual),b=lum(bg);const ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
  const size=parseFloat(s.fontSize),large=size>=24||(size>=18.66&&Number(s.fontWeight)>=700);const threshold=large?3:4.5;
  if(ratio+.03<threshold)rows.push({text:n.textContent.trim().slice(0,90),selector:e.tagName.toLowerCase()+'.'+e.className,ratio:+ratio.toFixed(2),threshold,foreground:s.color,background:bg.slice(0,3)});
 }
 return rows;
}'''

def check(name, condition=True):
    assert condition, name
    checks.append(name)

def shot(page, name):
    page.screenshot(path=str(OUT / (name + '.png')))
    main = page.locator('main')
    check(name + ': no horizontal page overflow', main.evaluate('(e)=>e.scrollWidth <= e.clientWidth + 2'))
    contrast.append({'view': name, 'failures': page.evaluate(CONTRAST)})

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
    page.set_default_timeout(10000)
    page.on('pageerror', lambda e: errors.append(str(e)))
    try:
        page.goto(BASE)
        page.wait_for_selector('.case-steps')
        page.request.post(BASE + '/api/session', data={'role': 'instructor'})
        page.reload()
        nav = page.get_by_role('navigation', name='Destinations')
        if page.get_by_role('button', name='Prepare rehearsal (one-time setup)', exact=True).count():
            page.get_by_role('button', name='Prepare rehearsal (one-time setup)', exact=True).click()
        page.get_by_role('button', name='Return to original case', exact=True).click()
        expect(page.locator('.notice-success')).to_contain_text('Original decision opened')
        original = page.request.get(BASE + '/api/overview').json()
        original_id = original['activeId']
        original_exercise = next(x for x in original['exercises'] if x['id'] == original_id)
        ledger = original['platform']['requests']
        shot(page, '01-case')
        page.get_by_role('button', name='Open decision and source timeline', exact=True).click()
        expect(page.get_by_role('heading', name='Decision review', exact=True)).to_be_visible()
        check('Original decision opens in Review')
        shot(page, '02-review-decision')
        nav.get_by_role('button', name='Instructor case', exact=True).click()
        page.locator('.case-steps button').nth(1).click()
        page.get_by_role('button', name='Retrieve this decision’s evidence', exact=True).click()
        expect(page.locator('svg[aria-label="Decision evidence graph with executed retrieval paths"]')).to_be_visible()
        check('Actual decision graph retrieval displayed')
        page.get_by_label('Find entity', exact=False).fill('Bulletin')
        page.locator('.decision-retrieval svg [role=button]').first.click()
        expect(page.get_by_role('button', name='Open original evidence at this tick', exact=True)).to_be_visible()
        shot(page, '03-evidence-path')
        page.get_by_role('button', name='Open original evidence at this tick', exact=True).click()
        expect(page.locator('#review-source-perspective')).to_be_visible()
        check('Source drilldown opens the exact report perspective')
        nav.get_by_role('button', name='Instructor case', exact=True).click()
        page.locator('.case-steps button').nth(2).click()
        page.get_by_role('button', name='Read the saved Luna analysis and cited evidence', exact=True).click()
        page.get_by_role('button', name='Inspect headline source', exact=False).first.click()
        expect(page.get_by_role('heading', name='Exact saved citation', exact=False)).to_be_visible()
        shot(page, '04-recorded-analysis')
        page.locator('.case-steps button').nth(3).click()
        if page.get_by_role('button', name='Open the original case to add your review', exact=True).count():
            page.get_by_role('button', name='Open the original case to add your review', exact=True).click()
        page.get_by_label('Your qualified review and next practice', exact=True).fill('Automated frontend qualification: retain uncertainty and test a 10 percent commitment. This is synthetic practice, not instructor acceptance.')
        page.get_by_role('button', name='Save post-hoc review note', exact=True).click()
        expect(page.get_by_text('1 qualified review note saved.', exact=False)).to_be_visible()
        page.locator('summary').filter(has_text='presenter-review-note.json').last.click()
        page.get_by_role('button', name='Inspect original file', exact=True).last.click()
        expect(page.get_by_role('heading', name='presenter-review-note.json · original', exact=True)).to_be_visible()
        check('Post-hoc note saved and original file inspected')
        shot(page, '05-instructor-note')
        page.locator('.case-steps button').nth(4).click()
        with page.expect_response(lambda r: r.url.endswith('/api/branches') and r.request.method == 'POST') as branch_response:
            page.get_by_role('button', name='Start a new legal practice branch', exact=True).click()
        check('Branch endpoint accepted', branch_response.value.ok)
        page.locator('#troop-pct').wait_for()
        branch_id = page.request.get(BASE + '/api/overview').json()['activeId']
        page.locator('#troop-pct').fill('10')
        page.locator('.decision-note > summary').filter(has_text='Decision note').click()
        page.locator('#order-reason').fill('Automated UI check: retain 90 percent reserve and use the cited report for this legal alternative.')
        page.locator('.decision-source input').first.check()
        with page.expect_response(lambda r: '/api/command' in r.url and r.request.method == 'POST') as command_response:
            page.get_by_role('button', name='Expand', exact=True).click()
        check('Legal 10 percent order accepted', command_response.value.ok)
        shot(page, '06-practice-order')
        page.get_by_role('group', name='Exercise desk').get_by_role('button', name='Staff', exact=True).click()
        page.get_by_role('tab', name='Watches', exact=False).click()
        page.get_by_role('button', name='Report provenance', exact=True).click()
        page.get_by_role('button', name='Add watch', exact=True).click()
        expect(page.get_by_text('Monitor report provenance', exact=True).first).to_be_visible()
        check('Staff panel can create a free provenance watch')
        page.get_by_role('button', name='End for review', exact=True).first.click()
        with page.expect_response(lambda r: r.url.endswith('/finish') and r.request.method == 'POST') as finish_response:
            page.get_by_role('button', name='Confirm: end for review', exact=True).first.click()
        check('Branch ended for review', finish_response.value.ok)
        nav.get_by_role('button', name='My practice', exact=True).click()
        page.get_by_role('button', name='Reasons & sources', exact=True).click()
        expect(page.locator('.obs-rationale:visible').filter(has_text='Automated UI check:').first).to_be_visible()
        shot(page, '07-practice-history')
        page.reload()
        nav.get_by_role('button', name='My practice', exact=True).click()
        page.get_by_role('button', name='Reasons & sources', exact=True).click()
        expect(page.locator('.obs-rationale:visible').filter(has_text='Automated UI check:').first).to_be_visible()
        check('Practice record survives reload')
        nav.get_by_role('button', name='Review', exact=True).click()
        page.get_by_role('button', name='Debrief & handoff', exact=True).click()
        with page.expect_download() as downloaded:
            page.get_by_role('link', name='Download evidence bundle', exact=True).click()
        downloaded.value.save_as(OUT / downloaded.value.suggested_filename)
        check('Branch evidence bundle downloaded')
        shot(page, '08-debrief')
        for name in ['Library', 'Platform']:
            nav.get_by_role('button', name=name, exact=True).click()
            page.wait_for_timeout(250)
            shot(page, '09-' + name.lower())
        page.get_by_role('button', name='Connections & tools', exact=True).click()
        shot(page, '10-connections')
        page.get_by_role('button', name='Usage & records', exact=True).click()
        shot(page, '11-usage')
        # Test the keyboard path, then narrow layouts for each principal workspace.
        nav.get_by_role('button', name='Instructor case', exact=True).focus()
        page.keyboard.press('Enter')
        expect(page.get_by_role('heading', name='Instructor case', exact=True)).to_be_visible()
        check('Primary navigation works with the keyboard')
        for width in [1024, 390]:
            page.set_viewport_size({'width':width,'height':900})
            for name in ['Instructor case','Exercise','Review','My practice','Library','Platform']:
                nav.get_by_role('button',name=name,exact=True).click()
                page.wait_for_timeout(150)
                shot(page,str(width)+'-'+name.lower().replace(' ','-'))
        final = page.request.get(BASE + '/api/overview').json()
        unchanged = next(x for x in final['exercises'] if x['id'] == original_id)
        check('Original exercise record summary unchanged', original_exercise == unchanged)
        check('No application model requests', final['platform']['requests'] == ledger)
        check('No unhandled browser errors', not errors)
        check('Sampled visible HTML text meets contrast thresholds', all(not row['failures'] for row in contrast))
        receipt = {'status':'passed','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'checks':checks,'contrast':contrast,'browser_errors':errors,'branch_id':branch_id,'model_requests_before':ledger,'model_requests_after':final['platform']['requests'],'scope':'Isolated local-demo browser. Native deployment qualification is separate.'}
        (OUT/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
        print(json.dumps({'status':'passed','checks':len(checks),'contrast_failures':sum(len(x['failures']) for x in contrast),'receipt':str(OUT/'receipt.json')}))
    except Exception as exc:
        page.screenshot(path=str(OUT/'failure.png'))
        (OUT/'failure.json').write_text(json.dumps({'status':'failed','error':str(exc),'checks':checks,'contrast':contrast,'browser_errors':errors},indent=2)+'\n')
        raise
    finally:
        if branch_id:
            page.request.post(BASE+'/api/exercises/'+branch_id+'/finish',data={})
        browser.close()
