import type { UploadedFile } from '../shared/types';
export function json(method: string, body: unknown): RequestInit { return { method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) }; }
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
 const response = await fetch(path, { ...options, credentials:'same-origin', headers:{'X-Requested-With':'family-space',...options.headers} });
 const value = await response.json().catch(()=>({error:'Не удалось прочитать ответ сервера'}));
 if (!response.ok) throw new Error(value.error || 'Не удалось выполнить действие');
 return value as T;
}
export function upload(file: File, onProgress?: (progress:number)=>void): Promise<UploadedFile> { return new Promise((resolve,reject)=>{ const xhr=new XMLHttpRequest(); xhr.open('POST','/api/files'); xhr.setRequestHeader('X-Requested-With','family-space'); xhr.withCredentials=true; xhr.upload.onprogress=e=>{if(e.lengthComputable)onProgress?.(Math.round(e.loaded/e.total*100));}; xhr.onerror=()=>reject(new Error('Загрузка прервалась. Попробуйте ещё раз.')); xhr.onload=()=>{let data;try{data=JSON.parse(xhr.responseText);}catch{reject(new Error('Не удалось загрузить файл'));return;} if(xhr.status>=200&&xhr.status<300)resolve(data);else reject(new Error(data.error || 'Не удалось загрузить файл'));};const form=new FormData();form.append('file',file);xhr.send(form); }); }
