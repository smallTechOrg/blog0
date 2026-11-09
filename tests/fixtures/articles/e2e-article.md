A lot of people on the TL preaching that **you no longer need tech**. Tech is no longer a differentiator. AI democratises tech. Anyone can build and scale products with [Zer0](https://zero.smalltech.in/) tech expertise, and all such wild claims.

Our job here at [smallTech](https://smalltech.in/) is to help you sift the useful from the BS. And to help you define an **AI strategy not based on trends but fundamentals**. So are all these claims true? Like most important questions of life the answer is, It Depends (Context is Everything).

@@fig:slide47@@

Yes, you can build software today without tech expertise. But the fact is that even before AI, tech knowledge wasn’t the huge barrier we assume it was. All programmers, including me, have learnt from the internet (using Google, StackOverflow and Official Docs). We built, we made mistakes and we learnt. **Nobody stopped you from building "agents" or "orchestrators" even before AI.** But something has changed hasn’t it?

**Humans are creatures of convenience.** Even the smallest barrier to act discourages us. Everyone had the resources to build their own apps and agents a decade ago. But except for the driven folks nobody attempted it. I can imagine how hard it was to code in 2010, where I would handwrite and format code into a Notepad++. And today, I don’t even bother to complete my statements because pressing TAB lets *AI read my mind now.*

@@fig:ab-companies@@

The point I am coming to folks, is that **the barrier is a factor but it is not the ultimate factor.** You still need to have the patience to deal with the ugliness of the software when it breaks, because it will break. You may say, oh 99% accuracy is good enough for me. You know the potholes on your streets, do you think that falls into the 99% or the 1% of issues? The 1% is what can make a city heaven or hell. And who knows maybe that 1% is the difference between your business surviving or getting washed away.

AI will get you almost all the way there. But when you have built the thing and you are running the thing, you will run into the 1% problems. If you don’t care about the 1% go ahead, AI will work perfect for you. **If you want to re-invent the wheel go ahead and do it.** But if you want to build great products and great businesses, you can’t ignore the 1%. And yeah that’s when you’ll need Tech, and that’s when you’ll need humans.

## The 1% in practice

Here is how the two kinds of work compare when something breaks in production.[^ops]

| Work | AI handles it | Humans still needed |
|---|---|---|
| Scaffolding a new app | Mostly | Rarely |
| Debugging a production outage | Sometimes | Always |
| Choosing what to build | Never | Always |

The smallest guard against the 1% is code that refuses to guess when the input is wrong.

```ts
export function share(part: number, whole: number): number {
  if (whole <= 0) throw new Error('whole must be positive.');
  return Math.round((part / whole) * 1000) / 10;
}
```

[^ops]: Production is where the 1% problems live, long after the demo has impressed everyone.
