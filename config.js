// Public anon key (safe with RLS). Do not put service_role here.
export const SUPABASE_URL = 'https://kzzyxdkzqmjhxzqguxeu.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6enl4ZGt6cW1qaHh6cWd1eGV1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ3OTkwNjIsImV4cCI6MjEwMDM3NTA2Mn0.9cAz_VB7pIXGC5AydOKRqKLX4g5Xb7xZa2Gpk36MLTE';

export function isSupabaseConfigured() {
    return (
        SUPABASE_URL &&
        SUPABASE_ANON_KEY &&
        !SUPABASE_URL.includes('YOUR_SUPABASE') &&
        !SUPABASE_ANON_KEY.includes('YOUR_SUPABASE')
    );
}