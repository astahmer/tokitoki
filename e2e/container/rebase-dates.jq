def rebase_dates($offset):
  if type == "object" then
    with_entries(.value |= rebase_dates($offset))
  elif type == "array" then
    map(rebase_dates($offset))
  elif type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}(T.*)?$") then
    . as $value
    | ($value[0:10] + "T00:00:00Z" | fromdateiso8601 + $offset | strftime("%Y-%m-%d")) + $value[10:]
  else
    .
  end;

rebase_dates($offset)
