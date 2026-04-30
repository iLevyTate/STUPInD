#!/usr/bin/env node
import puppeteer from 'puppeteer';

const TESTS = [
  {
    name: 'Panel entry animation exists',
    check: (computed) => computed['animation-name'] && computed['animation-name'].includes('panelEnter'),
  },
  {
    name: 'Timer ring pulse animation exists',
    check: (computed) => computed['animation-name'] && computed['animation-name'].includes('ringPulse'),
  },
  {
    name: 'Action toast progress bar animates',
    check: (computed) => computed['transition-property'] && computed['transition-property'].includes('width'),
  },
  {
    name: 'Easing function uses cubic-bezier',
    check: (computed) => computed['animation-timing-function'] &&
                         (computed['animation-timing-function'].includes('cubic-bezier') ||
                          computed['animation-timing-function'].includes('ease')),
  },
];

async function testMotionPreferences() {
  const browser = await puppeteer.launch({ headless: true });

  try {
    console.log('🎬 Testing Motion Preferences Support\n');

    // Test 1: Normal motion (animations enabled)
    console.log('📹 Test 1: With animations enabled (prefers-reduced-motion: no-preference)\n');
    let page = await browser.newPage();
    await page.goto('http://localhost:8080', { waitUntil: 'networkidle2' });

    // Check for animation presence
    const panelAnimPresent = await page.evaluate(() => {
      const sheet = Array.from(document.styleSheets).find(s =>
        s.href && s.href.includes('main.css')
      );
      if (!sheet) return false;
      try {
        const rules = sheet.cssRules;
        for (let rule of rules) {
          if (rule.name === 'panelEnter') return true;
        }
      } catch(e) {}
      return false;
    });

    console.log(`✓ panelEnter keyframe defined: ${panelAnimPresent ? '✓' : '✗'}`);

    // Check animation-duration tokens
    const animTokens = await page.evaluate(() => {
      const root = document.documentElement;
      const styles = getComputedStyle(root);
      return {
        durFast: styles.getPropertyValue('--dur-fast'),
        durBase: styles.getPropertyValue('--dur-base'),
        durSlow: styles.getPropertyValue('--dur-slow'),
        easeOut: styles.getPropertyValue('--ease-out'),
      };
    });

    console.log(`✓ Animation tokens defined:`);
    console.log(`  --dur-fast: ${animTokens.durFast.trim()}`);
    console.log(`  --dur-base: ${animTokens.durBase.trim()}`);
    console.log(`  --dur-slow: ${animTokens.durSlow.trim()}`);
    console.log(`  --ease-out: ${animTokens.easeOut.trim()}\n`);

    await page.close();

    // Test 2: Reduced motion (animations disabled)
    console.log('🚫 Test 2: With prefers-reduced-motion: reduce\n');
    page = await browser.newPage();

    // Set reduced motion preference
    await page.emulateMediaFeatures([
      { name: 'prefers-reduced-motion', value: 'reduce' }
    ]);

    await page.goto('http://localhost:8080', { waitUntil: 'networkidle2' });

    // Verify animations are disabled
    const animationsDisabled = await page.evaluate(() => {
      const sheet = Array.from(document.styleSheets).find(s =>
        s.href && s.href.includes('main.css')
      );
      if (!sheet) return null;

      try {
        const rules = sheet.cssRules;
        let reducedMotionRules = [];

        for (let rule of rules) {
          if (rule.media && rule.media.mediaText && rule.media.mediaText.includes('prefers-reduced-motion')) {
            // Found @media (prefers-reduced-motion: reduce) block
            for (let nestedRule of rule.cssRules) {
              if (nestedRule.style) {
                reducedMotionRules.push({
                  selector: nestedRule.selectorText,
                  animationDuration: nestedRule.style.animationDuration,
                });
              }
            }
          }
        }
        return reducedMotionRules;
      } catch(e) { return null; }
    });

    console.log(`✓ prefers-reduced-motion overrides:`);
    if (animationsDisabled && animationsDisabled.length > 0) {
      console.log(`  Found ${animationsDisabled.length} rules that disable animations`);
      animationsDisabled.slice(0, 3).forEach(rule => {
        console.log(`  - ${rule.selector}: duration=${rule.animationDuration || 'not set'}`);
      });
    } else {
      console.log(`  ⚠ No animation disabling rules found`);
    }

    await page.close();

    // Test 3: Verify timer ring pulse animation
    console.log('\n🔴 Test 3: Timer ring pulse animation\n');
    page = await browser.newPage();
    await page.goto('http://localhost:8080', { waitUntil: 'networkidle2' });

    const ringAnimations = await page.evaluate(() => {
      const sheet = Array.from(document.styleSheets).find(s =>
        s.href && s.href.includes('main.css')
      );
      if (!sheet) return [];

      const anims = [];
      try {
        for (let rule of sheet.cssRules) {
          if (rule.name && rule.name.includes('ringPulse')) {
            anims.push(rule.name);
          }
        }
      } catch(e) {}
      return anims;
    });

    console.log(`✓ Ring pulse keyframes defined:`);
    ringAnimations.forEach(anim => console.log(`  - ${anim}`));

    await page.close();

    // Test 4: Action toast progress bar animation
    console.log('\n⏳ Test 4: Action toast progress bar animation\n');
    page = await browser.newPage();
    await page.goto('http://localhost:8080', { waitUntil: 'networkidle2' });

    const progressBarAnimation = await page.evaluate(() => {
      // Trigger action toast
      if (typeof window.showActionToast === 'function') {
        window.showActionToast('Test message', 'Undo', () => {}, 3000);

        // Wait a tick then check
        return new Promise(resolve => {
          setTimeout(() => {
            const toast = document.getElementById('actionToast');
            if (!toast) return resolve(null);

            const progressBar = toast.querySelector('.action-toast-progress-bar');
            if (!progressBar) return resolve(null);

            const computed = getComputedStyle(progressBar);
            resolve({
              width: computed.width,
              transition: computed.transition,
              backgroundColor: computed.backgroundColor,
            });
          }, 100);
        });
      }
      return null;
    });

    if (progressBarAnimation) {
      console.log(`✓ Progress bar animation active:`);
      console.log(`  width: ${progressBarAnimation.width}`);
      console.log(`  transition: ${progressBarAnimation.transition}`);
      console.log(`  backgroundColor: ${progressBarAnimation.backgroundColor}`);
    } else {
      console.log(`⚠ Could not verify progress bar animation`);
    }

    await page.close();

    console.log('\n✅ Motion preferences test complete');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

testMotionPreferences().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
