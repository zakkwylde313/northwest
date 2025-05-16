// Vercel Serverless Function (e.g., /api/daily-blog-update.js)

import admin from 'firebase-admin';
import chromium from '@sparticuz/chrome-aws-lambda';
import puppeteer from 'puppeteer-core';
import RssParser from 'rss-parser';
import fs from 'fs';
import path from 'path';

// --- Firebase Admin SDK 초기화 ---
if (!admin.apps.length) {
  try {
    const serviceAccountJson = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_KEY_JSON_BASE64, 'base64').toString('utf-8');
    const serviceAccount = JSON.parse(serviceAccountJson);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('Firebase Admin SDK initialized successfully.');
  } catch (e) {
    console.error('Firebase Admin SDK initialization error:', e.message);
  }
}
const db = admin.firestore();
const rssParser = new RssParser();

// --- 설정값 ---
const CHALLENGE_START_DATE = new Date('2025-05-26T00:00:00Z');
const CHALLENGE_END_DATE = new Date('2025-06-25T23:59:59Z');
const POST_RECOGNITION_CRITERIA = {
  minCharCountNoSpaces: 1000,
  minImageCount: 3,
};

// --- scrapeNaverBlogPost 함수 ---
async function scrapeNaverBlogPost(page, url) {
  try {
    console.log(`[Scraper] 페이지로 이동 중: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    console.log(`[Scraper] 메인 iframe을 찾습니다...`);
    const iframeElementHandle = await page.waitForSelector('iframe#mainFrame', { timeout: 15000 }).catch(() => null);
    if (!iframeElementHandle) {
      console.error('[Scraper] mainFrame iframe을 찾지 못했습니다.');
      return { success: false, error: 'mainFrame iframe을 찾지 못했습니다.' };
    }

    const frame = await iframeElementHandle.contentFrame();
    if (!frame) {
      console.error('[Scraper] 메인 iframe의 contentFrame을 가져올 수 없습니다.');
      return { success: false, error: '메인 iframe의 contentFrame을 가져올 수 없습니다.' };
    }
    console.log('[Scraper] 메인 iframe에 접근했습니다.');

    const postData = await frame.evaluate((criteria) => {
      const contentElement = document.querySelector('div.se-main-container') || document.querySelector('div#postViewArea');
      if (!contentElement) {
        return { success: false, error: '콘텐츠 요소를 찾을 수 없습니다.', text: '', charCountWithSpaces: 0, charCountNoSpaces: 0, imageCount: 0, allImageSources: [], filteredImageSources: [] };
      }

      const selectorsToRemove = [
        'div.se-module.se-module-map-text',
        'div.se-module.se-module-map-image',
        '.map_polyvore',
      ];
      selectorsToRemove.forEach(selector => {
        contentElement.querySelectorAll(selector).forEach(el => el.remove());
      });

      const rawText = contentElement.innerText;
      const text = rawText.trim();
      const charCountWithSpaces = text.length;
      const cleanedTextForCount = text.replace(/[\s\u200B-\u200D\uFEFF]+/g, '');
      const charCountNoSpaces = cleanedTextForCount.length;

      const allImages = contentElement.querySelectorAll('img');
      const allImageSources = [];
      const filteredImageSources = [];
      allImages.forEach(img => {
        const src = img.getAttribute('src');
        if (src) {
          allImageSources.push(src);
          if (
            src.includes('map.pstatic.net/nrb/') ||
            src.includes('common-icon-places-marker') ||
            src.includes('ssl.pstatic.net/static/maps/mantle/') ||
            src.includes('simg.pstatic.net/static.map/v2/map/staticmap.bin') ||
            (src.startsWith('data:image/') && src.length < 200) ||
            (img.width && img.width < 30) ||
            (img.height && img.height < 30)
          ) { /* 필터링 */ } else {
            filteredImageSources.push(src);
          }
        }
      });
      const imageCount = filteredImageSources.length;
      const isRecognized = charCountNoSpaces >= criteria.minCharCountNoSpaces && imageCount >= criteria.minImageCount;

      return {
        success: true, text, charCountWithSpaces, charCountNoSpaces, imageCount,
        allImageSources, filteredImageSources, isRecognized
      };
    }, POST_RECOGNITION_CRITERIA);

    console.log(`[Scraper] 데이터 추출 완료: ${url}`);
    return postData;

  } catch (error) {
    console.error(`[Scraper] ${url} 스크래핑 중 오류:`, error.message, error.stack);
    return { success: false, error: error.message };
  }
}

// --- Vercel Serverless Function Handler ---
export default async function handler(request, response) {
  if (!admin.apps.length && process.env.FIREBASE_SERVICE_ACCOUNT_KEY_JSON_BASE64) {
    try {
        const serviceAccountJson = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_KEY_JSON_BASE64, 'base64').toString('utf-8');
        const serviceAccount = JSON.parse(serviceAccountJson);
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount)
        });
        console.log('Firebase Admin SDK initialized successfully in handler.');
      } catch (e) {
        console.error('Firebase Admin SDK initialization error in handler:', e.message);
        if (response && typeof response.status === 'function') {
            response.status(500).send('서버 설정 오류: Firebase 초기화 실패');
        }
        return;
      }
  } else if (!admin.apps.length) {
    console.error('Firebase Admin SDK not initialized and no config found.');
    if (response && typeof response.status === 'function') {
        response.status(500).send('서버 설정 오류: Firebase 구성 누락');
    }
    return;
  }

  let browser = null;
  let puppeteerPage = null;

  try {
    console.log('일일 블로그 업데이트 작업을 시작합니다...');

    console.log('[Launcher] Vercel 환경용 Puppeteer 브라우저를 실행합니다...');
    try {
      // ▼▼▼ Puppeteer 실행 옵션 최종 진짜 최종 수정 ▼▼▼
      browser = await puppeteer.launch({
        args: chromium.args,                             // 일반 속성
        defaultViewport: chromium.defaultViewport,         // 일반 속성
        executablePath: await chromium.executablePath,   // await + 속성 (함수 호출 아님!)
        headless: await chromium.headless,                 // await + 속성 (함수 호출 아님!)
        ignoreHTTPSErrors: true,
      });
      // ▲▲▲ Puppeteer 실행 옵션 최종 진짜 최종 수정 ▲▲▲
      console.log('[Launcher] Puppeteer 브라우저 실행 성공.');
    } catch (launchError) {
      console.error('[Launcher] Puppeteer 브라우저 실행에 실패했습니다:', launchError.message, launchError.stack);
      if (response && typeof response.status === 'function') {
        response.status(500).send(`오류: Puppeteer 브라우저를 초기화할 수 없습니다. (${launchError.message})`);
      }
      return; 
    }
    
    console.log('[Launcher] 새 페이지를 엽니다...');
    puppeteerPage = await browser.newPage();
    console.log('[Launcher] User-Agent를 설정합니다...');
    await puppeteerPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    console.log('[Launcher] 페이지 준비 및 User-Agent 설정 완료.');

    const blogsSnapshot = await db.collection('blogs').where('isActive', '==', true).get();
    if (blogsSnapshot.empty) {
      console.log('처리할 활성 블로그가 없습니다.');
      if (response && typeof response.status === 'function') {
        response.status(200).send('처리할 활성 블로그가 없습니다.');
      }
      return;
    }

    for (const blogDoc of blogsSnapshot.docs) {
      const blogData = blogDoc.data();
      const blogId = blogDoc.id;
      console.log(`\n블로그 처리 중: ${blogData.name} (ID: ${blogId})`);

      if (!blogData.rssFeedUrl) {
        console.warn(`${blogData.name} 블로그에 RSS 피드 URL이 없습니다. 건너<0xEB><03><0x8D>니다.`);
        continue;
      }

      let feed;
      try {
        feed = await rssParser.parseURL(blogData.rssFeedUrl);
      } catch (rssError) {
        console.error(`${blogData.name} RSS 피드 파싱 오류: ${rssError.message}. 건너<0xEB><03><0x8D>니다.`);
        continue;
      }
      
      let newPostsInChallengeCount = 0;
      let recognizedPostsInBlog = 0;
      let latestPostDateForBlog = blogData.latestPostDateInChallenge ? blogData.latestPostDateInChallenge.toDate() : null;

      for (const item of feed.items) {
        const postDate = new Date(item.isoDate || item.pubDate);
        if (postDate < CHALLENGE_START_DATE || postDate > CHALLENGE_END_DATE) {
          continue; 
        }

        newPostsInChallengeCount++;
        const postLink = item.link;
        const cleanLink = postLink.split('?')[0].split('#')[0];
        const postId = `${blogId}_${Buffer.from(cleanLink).toString('base64')}`;

        const postRef = db.collection('posts').doc(postId);
        const postDocSnapshot = await postRef.get();

        if (postDocSnapshot.exists && postDocSnapshot.data().scrapedAt && 
            (new Date(postDocSnapshot.data().scrapedAt.toDate()) > new Date(Date.now() - 6 * 60 * 60 * 1000))) {
          console.log(`포스팅 ${item.title || postLink} 는(은) 이미 최근에 처리되었습니다. 통계만 집계.`);
          if (postDocSnapshot.data().isRecognized) {
            recognizedPostsInBlog++;
          }
        } else {
            console.log(`새 포스팅 또는 업데이트 필요한 포스팅 처리: ${item.title || postLink}`);
            const scrapedData = await scrapeNaverBlogPost(puppeteerPage, postLink);

            if (scrapedData && scrapedData.success) {
                const postToSave = {
                    blogId: blogId,
                    title: item.title || '제목 없음',
                    link: postLink,
                    publishDate: admin.firestore.Timestamp.fromDate(postDate),
                    contentFullText: scrapedData.text,
                    charCountWithSpaces: scrapedData.charCountWithSpaces,
                    charCountNoSpaces: scrapedData.charCountNoSpaces,
                    imageCount: scrapedData.imageCount,
                    isRecognized: scrapedData.isRecognized,
                    adminFeedback: postDocSnapshot.exists ? postDocSnapshot.data().adminFeedback : null,
                    scrapedAt: admin.firestore.FieldValue.serverTimestamp(),
                };
                await postRef.set(postToSave, { merge: true });
                console.log(`포스팅 ${item.title || postLink} 정보 Firestore에 저장 완료.`);

                if (postToSave.isRecognized) {
                    recognizedPostsInBlog++;
                }
            } else {
                console.error(`포스팅 ${item.title || postLink} 스크래핑 실패: ${scrapedData?.error || '알 수 없는 오류'}`);
                if (postDocSnapshot.exists && postDocSnapshot.data().isRecognized) {
                    recognizedPostsInBlog++;
                }
            }
        }
        if (!latestPostDateForBlog || postDate > latestPostDateForBlog) {
            latestPostDateForBlog = postDate;
        }
      }

      const blogUpdateData = {
        totalPostsInChallenge: newPostsInChallengeCount,
        recognizedPostsInChallenge: recognizedPostsInBlog,
      };
      if (latestPostDateForBlog) {
          blogUpdateData.latestPostDateInChallenge = admin.firestore.Timestamp.fromDate(latestPostDateForBlog);
      }

      await db.collection('blogs').doc(blogId).update(blogUpdateData);
      console.log(`${blogData.name} 블로그 요약 정보 업데이트 완료.`);
    }

    if (response && typeof response.status === 'function') {
        console.log('모든 블로그 처리 완료.');
        response.status(200).send('일일 블로그 업데이트 작업이 성공적으로 완료되었습니다.');
    }

  } catch (error) {
    console.error('일일 블로그 업데이트 작업 중 심각한 오류 발생:', error.message, error.stack);
    if (response && typeof response.status === 'function') {
        response.status(500).send(`서버 오류: ${error.message}`);
    }
  } finally {
    if (browser) {
      console.log('브라우저를 닫습니다...');
      await browser.close();
    }
  }
}