export class ClickUp {
  constructor(token, writes = false, runtime = {}) {
    this.token = token; this.writes = writes;
    this.fetch = runtime.fetch ?? globalThis.fetch;
    this.sleep = runtime.sleep ?? (ms => new Promise(resolve => setTimeout(resolve,ms)));
    this.now = runtime.now ?? Date.now;
    this.log = runtime.log ?? (message => console.error(message));
    this.nextRequest = 0;
  }
  async waitUntil(time) {
    while(this.now()<time) await this.sleep(Math.min(30000,time-this.now()));
  }
  async request(path, query = {}, method = 'GET', body) {
    if (method !== 'GET' && !this.writes) throw Error('Live writes disabled; use sync --apply');
    const url = new URL(`https://api.clickup.com/api/v2/${path}`);
    Object.entries(query).forEach(([k,v]) => url.searchParams.set(k, String(v)));
    for(let attempt=0;;attempt++) {
      await this.waitUntil(this.nextRequest);
      this.nextRequest=this.now()+650;
      const res = await this.fetch(url, {method, headers: {Authorization: this.token, 'Content-Type':'application/json'}, body: body && JSON.stringify(body), signal: AbortSignal.timeout(60000)});
      const reset=Number(res.headers.get('x-ratelimit-reset'))*1000;
      if(res.status===429 && attempt<5) {
        const retryAfter=res.headers.get('retry-after');
        const retryTime=retryAfter ? (Number.isFinite(Number(retryAfter)) ? this.now()+Number(retryAfter)*1000 : Date.parse(retryAfter)) : 0;
        const retryAt=Math.max(this.now()+1000,Number.isFinite(reset)?reset+1000:0,Number.isFinite(retryTime)?retryTime:0);
        this.nextRequest=Math.max(retryAt,this.now()+(reset || retryTime ? 1000 : 5000*2**attempt));
        this.log(`ClickUp rate limit reached; retrying in ${Math.ceil((this.nextRequest-this.now())/1000)}s (${attempt+1}/5).`);
        await res.body?.cancel();
        continue;
      }
      if (!res.ok) throw Error(`ClickUp ${method} ${path}: HTTP ${res.status}`);
      if(res.headers.get('x-ratelimit-remaining')==='0' && reset>this.now()) this.nextRequest=Math.max(this.nextRequest,reset+1000);
      return res.json();
    }
  }
  async registry(id) {
    const result = [];
    for (let page=0;;page++) {
      const r = await this.request(`list/${id}/task`, {page, include_closed:true, subtasks:true});
      if (!Array.isArray(r.tasks)) throw Error('Incomplete registry response');
      result.push(...r.tasks);
      if (r.last_page === true || r.tasks.length === 0) return result;
    }
  }
  task(id) { return this.request(`task/${id}`, {include_markdown_description:true}); }
  view(id) { return this.request(`view/${id}`); }
  async members(workspace) {
    const {teams} = await this.request('team');
    const team = teams?.find(t => String(t.id) === workspace);
    if (!team?.members?.length) throw Error('Workspace membership unavailable');
    const me = await this.request('user');
    this.dateTimezone = me.user?.timezone;
    const role = team.members.find(m => String(m.user.id) === String(me.user?.id))?.user.role;
    if (![1,2].includes(Number(role))) throw Error('Owner/admin API token required for all-staff time');
    return [...new Set(team.members.map(m => String(m.user.id)))];
  }
  folder(id) { return this.request(`folder/${id}`, {include_subfolders:true}); }
  async lists(id) {
    const lists=[];
    for (const archived of [false,true]) {
      const r=await this.request(`folder/${id}/list`, {archived});
      if (!Array.isArray(r.lists)) throw Error('Incomplete List response');
      lists.push(...r.lists);
    }
    return lists;
  }
  async entries(workspace, list, staff, start, end) {
    const entries=[];
    // The API accepts comma-separated assignees; avoid one request per person/day.
    const window=30*86400000;
    if(!staff.length) throw Error('Cannot fetch time without staff IDs');
    for (let from=start;from<end;from+=window) {
      for (let offset=0;offset<staff.length;offset+=50) {
        const r=await this.request(`team/${workspace}/time_entries`, {list_id:list, assignee:staff.slice(offset,offset+50).join(','),start_date:from,end_date:Math.min(end,from+window)-1});
        if (!Array.isArray(r.data)) throw Error('Incomplete time response');
        entries.push(...r.data);
      }
    }
    return entries;
  }
  async comments(id) {
    const all=[]; let cursor={}; const seen=new Set();
    for (;;) {
      const r=await this.request(`task/${id}/comment`,cursor);
      if (!Array.isArray(r.comments)) throw Error('Incomplete comments response');
      all.push(...r.comments);
      if (!r.comments.length) return all;
      const last=r.comments.at(-1);
      if (!last.id || !last.date || seen.has(last.id)) throw Error('Invalid comments pagination');
      seen.add(last.id); cursor={start:last.date,start_id:last.id};
    }
  }
  update(id, description) { return this.request(`task/${id}`,{},'PUT',{markdown_description:description}); }
  setField(id, field, value) { return this.request(`task/${id}/field/${field}`,{},'POST',{value}); }
  comment(id, text) { return this.request(`task/${id}/comment`,{},'POST',{comment_text:text,notify_all:true}); }
}
