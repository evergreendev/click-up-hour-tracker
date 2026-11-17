export class ClickUp {
  constructor(token, writes = false) { this.token = token; this.writes = writes; }
  async request(path, query = {}, method = 'GET', body) {
    if (method !== 'GET' && !this.writes) throw Error('Live writes disabled; use sync --apply');
    const url = new URL(`https://api.clickup.com/api/v2/${path}`);
    Object.entries(query).forEach(([k,v]) => url.searchParams.set(k, String(v)));
    const res = await fetch(url, {method, headers: {Authorization: this.token, 'Content-Type':'application/json'}, body: body && JSON.stringify(body), signal: AbortSignal.timeout(60000)});
    if (!res.ok) throw Error(`ClickUp ${method} ${path}: HTTP ${res.status}`);
    return res.json();
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
  async members(workspace) {
    const {teams} = await this.request('team');
    const team = teams?.find(t => String(t.id) === workspace);
    if (!team?.members?.length) throw Error('Workspace membership unavailable');
    const me = await this.request('user');
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
    // Small windows bound response sizes; endpoint has no documented pagination.
    for (let from=start;from<end;from+=86400000) {
      for (const user of staff) {
        const r=await this.request(`team/${workspace}/time_entries`, {list_id:list, assignee:user,start_date:from,end_date:Math.min(end,from+86400000)-1});
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
