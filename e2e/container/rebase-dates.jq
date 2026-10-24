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
| if type == "object" and (.limits | type) == "array" then
    (now | strftime("%Y-%m-%dT00:00:00Z") | fromdateiso8601) as $today
    | (now | strftime("%Y-%m-01T00:00:00Z") | fromdateiso8601) as $month
    | (($month + 32 * 86400) | strftime("%Y-%m-01T00:00:00Z") | fromdateiso8601) as $next_month
    | .limits |= map(
        if (.budgetWindows | type) == "array" then
          .budgetWindows |= map(
            if .kind == "day" then
              .windowStart = ($today | todateiso8601) | .windowEnd = ($today + 86400 | todateiso8601)
            elif .kind == "month" then
              .windowStart = ($month | todateiso8601) | .windowEnd = ($next_month | todateiso8601)
            else . end)
        else . end)
  else . end
