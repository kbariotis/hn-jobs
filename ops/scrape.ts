//https://hacker-news.firebaseio.com/v0/item/46108941.json
//https://hn.algolia.com/api/v1/items/46108941

import { writeFileSync } from "fs";

async function main() {
  const response = await fetch("https://hn.algolia.com/api/v1/items/46108941");
  const data = await response.json();
  console.log(data.kids);

  const entries = [];

  for await (const kid of data.children) {
    entries.push({
      id: kid.id,
      author: kid.author,
      text: kid.text,
      time: kid.created_at_i,
      thread_id: 46108941,
    });
  }

  writeFileSync("hn.json", JSON.stringify(entries), "utf8");
}
main().catch(console.error);
