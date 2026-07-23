// Supabase 프로젝트 설정
// 1) 이 파일을 복사해 config.js 로 저장하세요.
// 2) Dashboard → Project Settings → API 에서 URL / anon key 를 붙여넣으세요.
export const SUPABASE_URL = 'YOUR_SUPABASE_URL';
export const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';

export function isSupabaseConfigured() {
    return (
        SUPABASE_URL &&
        SUPABASE_ANON_KEY &&
        !SUPABASE_URL.includes('YOUR_SUPABASE') &&
        !SUPABASE_ANON_KEY.includes('YOUR_SUPABASE')
    );
}
