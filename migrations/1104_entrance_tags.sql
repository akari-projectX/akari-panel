-- next-version: tags belong to entrances.
--
-- A node's tags (W11, nodes.tags) used to be appended to the name of every
-- entrance of the node, so a direct entrance and an "IPLC" relay showed the
-- same tags. Tags are now set per entrance; the subscription names, the
-- portal's line list and the admin entrance table read entrances.tags.
-- nodes.tags stays (old API clients may still write it) but nothing shows
-- it any more. Existing node tags are copied to each of the node's
-- entrances, so names do not change on upgrade.
--
-- Same rules as nodes.tags (nodemeta::tags: ≤ 8, ≤ 24 printable
-- characters each, no '|', no duplicates; the API checks the details).

ALTER TABLE entrances ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE entrances ADD CONSTRAINT entrances_tags CHECK (
    cardinality(tags) <= 8 AND array_position(tags, NULL) IS NULL);

UPDATE entrances e SET tags = n.tags FROM nodes n
 WHERE n.id = e.node_id AND cardinality(n.tags) > 0;
