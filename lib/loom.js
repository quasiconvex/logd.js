var Sun = require('sky/sun')

var Loom = module.exports = {
  edgeHull: function (x, y) {
    return Sun.fold(function (acc, item) {
      var node = item[0], xmark = item[1]
      if (Sun.lt(y[node], xmark))
        acc[node] = xmark;
      return acc;
    }, Sun.up({}, y), x)
  },
  locusBefore: function (locus) {
    // {which.node: [which.logid, which.range.lower]}
    return Sun.object([[locus[0][0], [locus[0][1], locus[1][0]]]])
  },
  locusAfter: function (locus) {
    // {which.node: [which.logid, which.range.upper]}
    return Sun.object([[locus[0][0], [locus[0][1], locus[1][1]]]])
  },
}
