import mathCss from 'katex/dist/katex.min.css?raw'
const fonts = import.meta.glob('../../node_modules/katex/dist/fonts/*.woff2', { eager:true, query:'?url&inline', import:'default' })
// Downloaded study sheets contain their math fonts and can be opened offline.
export const offlineMathCss = mathCss.replace(/src:([^;}]+)(;|(?=\}))/g, (source,urls,terminator) => {
  const name = /fonts\/([^)]*\.woff2)/.exec(urls)?.[1]
  const data = fonts['../../node_modules/katex/dist/fonts/'+name]
  return data ? `src:url(${data}) format("woff2")${terminator}` : source
})
