const puppeteer = require('puppeteer');
const fs = require('fs'); // 파일 시스템 모듈 가져오기
const path = require('path'); // 경로 관련 모듈 가져오기

async function scrapeNaverBlogPost(url) {
  let browser;
  try {
    console.log(`브라우저를 실행합니다...`);
    browser = await puppeteer.launch({
      headless: true, // 디버깅 시 false로 변경하여 브라우저 창 확인
      // args: ['--no-sandbox', '--disable-setuid-sandbox'] // Vercel 등 서버 환경용 옵션
    });

    console.log(`새 페이지를 엽니다...`);
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

    console.log(`페이지로 이동합니다: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    console.log(`메인 iframe을 찾습니다...`);
    const iframeElementHandle = await page.waitForSelector('iframe#mainFrame', { timeout: 15000 }).catch(err => {
        console.error('mainFrame iframe을 찾는 데 실패했거나 시간이 초과되었습니다:', err.message);
        return null;
    });

    if (!iframeElementHandle) return null;

    const frame = await iframeElementHandle.contentFrame();
    if (!frame) {
      console.error('메인 iframe의 contentFrame을 가져올 수 없습니다.');
      return null;
    }
    console.log('메인 iframe에 접근했습니다.');

    const postContent = await frame.evaluate(() => {
      const contentElement = document.querySelector('div.se-main-container') ||
                             document.querySelector('div#postViewArea');

      if (!contentElement) {
        return { success: false, error: '콘텐츠 요소를 찾을 수 없습니다.', text: '', charCountWithSpaces: 0, charCountNoSpaces: 0, imageCount: 0, allImageSources: [], filteredImageSources: [] };
      }

      const selectorsToRemove = [
          'div.se-module.se-module-map-text',
          'div.se-module.se-module-map-image',
          // 'div.se-placesMap', // 필요시 이 선택자 또는 실제 지도 전체 컨테이너 선택자로 변경/추가
          '.map_polyvore',
      ];
      
      selectorsToRemove.forEach(selector => {
          const elements = contentElement.querySelectorAll(selector);
          elements.forEach(element => {
            element.remove();
          });
      });

      const rawText = contentElement.innerText;
      const text = rawText.trim();
      const charCountWithSpaces = text.length;

      // ▼▼▼ 공백 및 주요 특수문자 제거 로직 강화 ▼▼▼
      // 일반 공백(\s)과 함께 제로 너비 공백(U+200B), 제로 너비 비결합자(U+200C), 제로 너비 결합자(U+200D), BOM(U+FEFF) 등을 제거
      const cleanedTextForCount = text.replace(/[\s\u200B-\u200D\uFEFF]+/g, ''); 
      const charCountNoSpaces = cleanedTextForCount.length;
      // ▲▲▲ 공백 및 주요 특수문자 제거 로직 강화 끝 ▲▲▲

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
          ) {
            // 이미지 필터링
          } else {
            filteredImageSources.push(src);
          }
        }
      });

      const imageCount = filteredImageSources.length;

      return {
        success: true,
        text: text, // 원본 innerText (trim만 적용된)
        charCountWithSpaces: charCountWithSpaces,
        charCountNoSpaces: charCountNoSpaces, // 특수문자까지 고려하여 계산된 수
        imageCount: imageCount,
        allImageSources: allImageSources,
        filteredImageSources: filteredImageSources
      };
    });

    // --- 결과 처리 (Node.js 컨텍스트) ---
    if (postContent && postContent.success) {
      console.log('\n--- 최종 추출된 내용 ---');
      console.log(`글자 수 (공백포함, trim 후): ${postContent.charCountWithSpaces}`);
      console.log(`글자 수 (공백제외, 특수문자 처리 후): ${postContent.charCountNoSpaces}`); // 로그 메시지 명확화
      console.log(`이미지 수 (필터링 후): ${postContent.imageCount}`);
      
      console.log('\n--- 필터링된 이미지 소스 목록 ---');
      if (postContent.filteredImageSources && postContent.filteredImageSources.length > 0) {
        postContent.filteredImageSources.forEach((src, index) => {
          console.log(`${index + 1}: ${src}`);
        });
      } else {
        console.log('콘텐츠 이미지가 없거나 모두 필터링되었습니다.');
      }

      const outputDir = 'output';
      const filePath = path.join(outputDir, 'extracted_text.txt');
      const cleanedFilePath = path.join(outputDir, 'cleaned_text_for_no_space_count.txt'); // 추가: 공백제외 카운트 대상 텍스트 저장

      try {
        if (!fs.existsSync(outputDir)){
            fs.mkdirSync(outputDir, { recursive: true });
            console.log(`'${outputDir}' 폴더를 생성했습니다.`);
        }
        // 원본 innerText (trim만 적용) 저장
        fs.writeFileSync(filePath, postContent.text, 'utf8');
        console.log(`\n추출된 전체 텍스트(trim 적용)를 '${filePath}' 파일로 저장했습니다.`);

        // 공백 및 특수문자 제거된 텍스트 저장 (디버깅용)
        // frame.evaluate 밖에서 다시 계산해야 함 (postContent.text를 사용)
        const textForNoSpaceCount = postContent.text.replace(/[\s\u200B-\u200D\uFEFF]+/g, '');
        fs.writeFileSync(cleanedFilePath, textForNoSpaceCount, 'utf8');
        console.log(`공백제외 카운트 대상 텍스트를 '${cleanedFilePath}' 파일로 저장했습니다.`);

      } catch (err) {
        console.error(`\n텍스트 파일 저장 중 오류 발생: ${err.message}`);
      }

    } else if (postContent && !postContent.success) {
      console.error(`콘텐츠 추출 실패 (브라우저 내부): ${postContent.error}`);
    } else {
      console.error('콘텐츠를 추출하지 못했습니다 (evaluate 결과가 null이거나 예상치 못한 구조).');
    }

    return postContent;

  } catch (error) {
    console.error(`스크래핑 중 치명적 오류 발생 (Node.js 외부): ${error.message}`);
    return null;
  } finally {
    if (browser) {
      console.log(`브라우저를 닫습니다...`);
      await browser.close();
    }
  }
}

// --- 스크립트 실행 ---
const testUrl = 'https://blog.naver.com/hyunstar7961/223864532206';

if (!testUrl || testUrl === '여기에_테스트할_네이버_블로그_포스트_URL을_넣어주세요') {
  console.warn('정확한 테스트 URL을 설정해주세요.');
} else {
  scrapeNaverBlogPost(testUrl).then(result => {
    if (result && result.success) {
      console.log('\n스크래핑 작업 성공적으로 완료.');
    } else {
      console.log('\n스크래핑 작업 중 오류가 발생했거나 일부 데이터를 가져오지 못했습니다.');
    }
  });
}